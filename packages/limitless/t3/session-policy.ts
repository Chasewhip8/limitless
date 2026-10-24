import type { Plugin } from '@opencode/plugin/effect'
import type { Permission } from '@opencode/schema/permission'
import type { Session } from '@opencode/schema/session'
import { Effect, Schema, Semaphore } from 'effect'
import {
	hasT3Permissions,
	isNormalizedT3Permissions,
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

/**
 * Rewrites a T3 thread's stored permissions into Limitless policy: T3's mode
 * rules (including Full access's allow-all) give way to native agent
 * configuration, and the thread's own T3 tools are scoped by role. Sessions
 * without T3's thread rules are left alone.
 */
export function makeT3SessionPolicy(
	context: Pick<Plugin.Context, 'session' | 'agent' | 'location'>,
) {
	/** Normalizes `permissions` for `session`, or returns undefined when they carry no T3 rules. */
	const normalizeFor = (session: Session.Info, permissions: Permission.Ruleset) =>
		Effect.gen(function* () {
			if (!hasT3Permissions(permissions)) return undefined
			if (
				session.location.directory !== context.location.directory ||
				session.location.workspaceID !== context.location.workspaceID
			) {
				return yield* new T3PolicyLocationError({ directory: session.location.directory })
			}
			const agent = yield* resolveSessionAgent(context, session)
			return yield* Effect.try({
				try: () => normalizeT3Permissions(permissions, agent),
				catch: (error) =>
					Schema.is(T3PermissionError)(error)
						? error
						: new T3PolicyError({ message: `Unable to normalize T3 permissions: ${error}` }),
			})
		})

	/**
	 * Repairs one recorded permission replacement, using the rules it carried
	 * rather than the session's current state. OpenCode delivers a session's
	 * writes in commit order, so even when a repair overwrites a newer T3 write,
	 * that write's own event follows and the session ends at the repaired form of
	 * T3's last write.
	 *
	 * T3 always writes its own raw rules, so a replacement already in repaired
	 * form, for whichever role the session had then, is the plugin's own write
	 * and ends the cycle. Another client copying repaired rules is outside this
	 * assumption; the prompt hook still corrects that session's role.
	 */
	const repair = (sessionID: Session.ID, recorded: Permission.Ruleset) =>
		withSessionPolicyLock(
			sessionID,
			Effect.gen(function* () {
				if (!hasT3Permissions(recorded) || isNormalizedT3Permissions(recorded)) return
				const session = yield* context.session.get({ sessionID })
				const normalized = yield* normalizeFor(session, recorded)
				if (normalized === undefined) return
				if (samePermissionRules(session.permissions ?? [], normalized)) return
				yield* context.session.update({ sessionID, permissions: normalized })
			}),
		)

	/**
	 * Repairs the session's current rules for its current role: at creation,
	 * including a native child's inherited rules, and before every prompt.
	 */
	const reconcile = (sessionID: Session.ID) =>
		withSessionPolicyLock(
			sessionID,
			Effect.gen(function* () {
				const session = yield* context.session.get({ sessionID })
				const current = session.permissions ?? []
				const normalized = yield* normalizeFor(session, current)
				if (normalized === undefined || samePermissionRules(current, normalized)) return
				yield* context.session.update({ sessionID, permissions: normalized })
			}),
		)

	return { repair, reconcile }
}
