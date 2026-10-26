import type { Plugin } from '@opencode/plugin/effect'
import type { SessionRequest } from '@opencode/plugin/effect/session'
import { Cause, Effect, Schema, Stream } from 'effect'
import { hasT3Context, injectT3Guidance, loadT3Guidance } from './instructions'
import { hasT3Permissions, isT3SupportAgent } from './permissions'
import { makeT3SessionPolicy, resolveSessionAgent, T3PolicyLocationError } from './session-policy'

type ServerEvent = Stream.Success<ReturnType<Plugin.Context['event']['subscribe']>>
// Both events carry a session's stored permissions: creation (including the
// inherited rules of a native child) and every later replacement, such as T3
// writing its mode's rules before a turn.
type PermissionEvent = Extract<ServerEvent, { type: 'session.created' | 'session.permissions' }>
const isPermissionEvent = (event: ServerEvent): event is PermissionEvent =>
	event.type === 'session.created' || event.type === 'session.permissions'

// Another Location's plugin instance owns that Location's sessions, and a
// session may be deleted before its event is handled.
const isLocationError = Schema.is(T3PolicyLocationError)
const isSessionNotFound = Schema.is(Schema.TaggedStruct('Session.NotFoundError', {}))

export const registerT3Policy = Effect.fn('registerT3Policy')(function* (context: Plugin.Context) {
	const guidance = yield* loadT3Guidance().pipe(Effect.orDie)
	const policy = makeT3SessionPolicy(context)

	// Repair T3's permission writes as soon as OpenCode records them.
	yield* context.event.subscribe().pipe(
		Stream.filter(isPermissionEvent),
		Stream.runForEach((event) => {
			const { sessionID } = event.data
			// Creation is a session's first event, so its current rules are the ones
			// to repair; each later replacement is repaired from the rules it carried.
			const repaired =
				event.type === 'session.created'
					? policy.reconcile(sessionID)
					: policy.repair(sessionID, event.data.permissions)
			return repaired.pipe(
				Effect.catchCause((cause) => {
					const error = Cause.squash(cause)
					return isLocationError(error) || isSessionNotFound(error)
						? Effect.void
						: Effect.logWarning('[limitless] could not apply T3 session policy', {
								sessionID,
								cause,
							})
				}),
			)
		}),
		Effect.forkScoped({ startImmediately: true }),
	)
	// Every prompt, including a native child's first, runs under repaired rules.
	yield* context.session.hook('prompt', (event) =>
		policy.reconcile(event.sessionID).pipe(Effect.orDie),
	)

	const inject = (request: SessionRequest, appendWhenMissing = true) =>
		Effect.gen(function* () {
			if (!appendWhenMissing && !hasT3Context(request)) return
			const session = yield* context.session.get({ sessionID: request.sessionID })
			if (!hasT3Permissions(session.permissions ?? [])) return
			const agent = yield* resolveSessionAgent(context, session)
			if (isT3SupportAgent(agent)) {
				injectT3Guidance(request, '')
				return
			}
			injectT3Guidance(request, guidance, appendWhenMissing)
		}).pipe(Effect.orDie)
	yield* context.session.hook('context', inject)
	yield* context.session.hook('generate', inject)
	yield* context.session.hook('compaction', inject)
	yield* context.session.hook('title', (request) => inject(request, false))
})
