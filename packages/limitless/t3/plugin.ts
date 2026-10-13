import type { Plugin } from '@opencode/plugin/effect'
import type { RpcCallContext } from '@opencode/plugin/effect/rpc'
import type { SessionRequest } from '@opencode/plugin/effect/session'
import type { Rpc } from '@opencode/schema/rpc'
import type { Session } from '@opencode/schema/session'
import { Effect, Schema } from 'effect'
import { hasT3Context, injectT3Guidance, loadT3Guidance } from './instructions'
import { hasT3Permissions, isT3SupportAgent, T3PermissionError } from './permissions'
import { T3PolicyRpc } from './rpc'
import {
	makeT3SessionPolicy,
	resolveSessionAgent,
	T3PolicyError,
	T3PolicyLocationError,
} from './session-policy'

const isSessionNotFound = Schema.is(Schema.TaggedStruct('Session.NotFoundError', {}))

function rpcResult(
	sessionID: Session.ID,
	operation: Effect.Effect<void, unknown>,
	context: RpcCallContext<typeof T3PolicyRpc.methods.prepareSession>,
) {
	return operation.pipe(
		Effect.as(null),
		Effect.catch(
			(
				error,
			): Effect.Effect<never, Rpc.HandlerError<typeof T3PolicyRpc.methods.prepareSession>> => {
				if (isSessionNotFound(error)) {
					return Effect.fail(
						context.error('session_not_found', 'OpenCode session no longer exists', { sessionID }),
					)
				}
				if (Schema.is(T3PolicyLocationError)(error)) {
					return Effect.fail(
						context.error('wrong_location', 'Policy request does not match the session location', {
							sessionID,
						}),
					)
				}
				if (Schema.is(T3PolicyError)(error) || Schema.is(T3PermissionError)(error)) {
					return Effect.fail(context.error('invalid_policy', error.message, { sessionID }))
				}
				return Effect.die(error)
			},
		),
	)
}

export const registerT3Policy = Effect.fn('registerT3Policy')(function* (context: Plugin.Context) {
	const guidance = yield* loadT3Guidance().pipe(Effect.orDie)
	const policy = makeT3SessionPolicy(context)
	yield* context.rpc
		.register(T3PolicyRpc, {
			updatePermissions: (input, rpc) =>
				rpcResult(input.sessionID, policy.update(input.sessionID, input.permissions), rpc),
			prepareSession: (input, rpc) =>
				rpcResult(input.sessionID, policy.prepare(input.sessionID), rpc),
		})
		.pipe(Effect.orDie)
	yield* context.session.hook('prompt', (event) =>
		policy.reconcile(event.sessionID).pipe(Effect.orDie),
	)
	const inject = (request: SessionRequest, appendWhenMissing = true) =>
		Effect.gen(function* () {
			if (!appendWhenMissing && !hasT3Context(request)) return
			const session = yield* context.session.get({ sessionID: request.sessionID })
			if (!hasT3Permissions(session.permissions ?? [])) return
			const agent = yield* resolveSessionAgent(context, session)
			injectT3Guidance(
				request,
				isT3SupportAgent(agent) ? guidance.support : guidance.primary,
				appendWhenMissing,
			)
		}).pipe(Effect.orDie)
	yield* context.session.hook('context', inject)
	yield* context.session.hook('generate', inject)
	yield* context.session.hook('compaction', inject)
	yield* context.session.hook('title', (request) => inject(request, false))
})
