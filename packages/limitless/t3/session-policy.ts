import type { Plugin } from '@opencode/plugin/effect'
import type { Permission } from '@opencode/schema/permission'
import type { Session } from '@opencode/schema/session'
import { Effect, Schema, Semaphore } from 'effect'
import {
	hasT3Permissions,
	normalizeT3Permissions,
	samePermissionRules,
	T3PermissionError,
} from './permissions'

type SessionLock = {
	users: number
	semaphore: ReturnType<typeof Semaphore.makeUnsafe>
}

export class T3PolicyError extends Schema.TaggedError<T3PolicyError>()('T3PolicyError', {
	message: Schema.String,
}) {}

export class T3PolicyLocationError extends Schema.TaggedError<T3PolicyLocationError>()(
	'T3PolicyLocationError',
	{
		directory: Schema.String,
	},
) {}

// OpenCode evaluates the plugin separately per Location. A process-wide registry
// prevents two instances from independently writing the same moving session.
const registryKey: unique symbol = Symbol.for('limitless.t3.session-policy.v1')
const processState: typeof globalThis & { [registryKey]?: Map<string, SessionLock> } = globalThis
const locks = processState[registryKey] ?? new Map<string, SessionLock>()
processState[registryKey] = locks

export function withSessionPolicyLock<A, E, R>(
	sessionID: string,
	operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
	return Effect.suspend(() => {
		let lock = locks.get(sessionID)
		if (lock === undefined) {
			lock = { users: 0, semaphore: Semaphore.makeUnsafe(1) }
			locks.set(sessionID, lock)
		}
		const active = lock
		active.users++
		return active.semaphore.withPermit(operation).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					active.users--
					if (active.users === 0) locks.delete(sessionID)
				}),
			),
		)
	})
}

export const resolveSessionAgent = Effect.fn('T3.resolveSessionAgent')(function* (
	context: Pick<Plugin.Context, 'agent'>,
	session: Pick<Session.Info, 'agent' | 'location'>,
) {
	if (session.agent !== undefined) return session.agent
	const available = yield* context.agent.list({
		location: { directory: session.location.directory },
	})
	// OpenCode lists its resolved default first, including project overrides.
	const selected = available.data[0]
	if (selected === undefined || selected.hidden || selected.mode === 'subagent') {
		return yield* new T3PolicyError({ message: 'Unable to resolve the default OpenCode agent' })
	}
	return selected.id
})

export function makeT3SessionPolicy(
	context: Pick<Plugin.Context, 'session' | 'agent' | 'location'>,
) {
	const apply = (sessionID: Session.ID, incoming?: Permission.Ruleset, required = false) =>
		withSessionPolicyLock(
			sessionID,
			Effect.gen(function* () {
				const session = yield* context.session.get({ sessionID })
				const permissions = incoming ?? session.permissions ?? []
				if (!required && incoming === undefined && !hasT3Permissions(permissions)) return
				if (
					session.location.directory !== context.location.directory ||
					session.location.workspaceID !== context.location.workspaceID
				) {
					return yield* new T3PolicyLocationError({ directory: session.location.directory })
				}

				const agent = yield* resolveSessionAgent(context, session)

				const normalized = yield* Effect.try({
					try: () => normalizeT3Permissions(permissions, agent),
					catch: (error) => {
						if (Schema.is(T3PermissionError)(error)) return error
						throw error
					},
				})
				if (samePermissionRules(session.permissions ?? [], normalized)) return
				yield* context.session.update({ sessionID, permissions: normalized })
			}),
		)

	return {
		update: (sessionID: Session.ID, permissions: Permission.Ruleset) =>
			apply(sessionID, permissions),
		reconcile: (sessionID: Session.ID) => apply(sessionID),
		prepare: (sessionID: Session.ID) => apply(sessionID, undefined, true),
	}
}
