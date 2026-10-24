import type { Plugin } from '@opencode/plugin/effect'
import type { Permission } from '@opencode/schema/permission'
import type { Session } from '@opencode/schema/session'
import { Deferred, Effect, Fiber } from 'effect'
import { expect, test } from 'vitest'
import { normalizeT3Permissions } from '../t3/permissions'
import { makeT3SessionPolicy, withSessionPolicyLock } from '../t3/session-policy'

test('serializes policy work for the same session', async () => {
	const history: string[] = []
	await Effect.runPromise(
		Effect.gen(function* () {
			const reading = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const first = yield* withSessionPolicyLock(
				'session-race',
				Effect.gen(function* () {
					history.push('first read')
					yield* Deferred.succeed(reading, undefined)
					yield* Deferred.await(release)
					history.push('first write')
				}),
			).pipe(Effect.forkChild)
			yield* Deferred.await(reading)
			const second = yield* withSessionPolicyLock(
				'session-race',
				Effect.sync(() => {
					history.push('second')
				}),
			).pipe(Effect.forkChild)
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(first)
			yield* Fiber.join(second)
		}),
	)
	expect(history).toEqual(['first read', 'first write', 'second'])
})

test('unrelated sessions proceed while another session is waiting', async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const ready = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const blocked = yield* withSessionPolicyLock(
				'session-one',
				Effect.gen(function* () {
					yield* Deferred.succeed(ready, undefined)
					yield* Deferred.await(release)
				}),
			).pipe(Effect.forkChild)
			yield* Deferred.await(ready)
			yield* withSessionPolicyLock('session-two', Deferred.succeed(release, undefined))
			yield* Fiber.join(blocked)
		}),
	)
})

test('a failed writer releases its session lock', async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const failure = yield* withSessionPolicyLock('session-failure', Effect.fail('failed')).pipe(
				Effect.flip,
			)
			expect(failure).toBe('failed')
			const result = yield* withSessionPolicyLock('session-failure', Effect.succeed('next'))
			expect(result).toBe('next')
		}),
	)
})

const rule = (action: string, effect: Permission.Effect, resource = '*'): Permission.Rule => ({
	action,
	resource,
	effect,
})
const anchors = [rule('t3-code-*', 'deny'), rule('t3-code-thread_*', 'allow')]

/**
 * One session in one Location, recording each permission write as OpenCode
 * would publish it. `racingWrite` lands right after the first read, before the
 * plugin's write: the interleaving that loses an update when repairs reread state.
 */
function fixture(initial: Permission.Ruleset, racingWrite?: Permission.Ruleset) {
	const sessionID = 'ses_child' as Session.ID
	let stored = initial
	let agent = 'research'
	let pendingRace = racingWrite
	const published: Permission.Ruleset[] = [initial]
	const directory = '/project'
	const context = {
		location: { directory },
		agent: {
			list: () => Effect.succeed({ data: [{ id: 'limitless', mode: 'primary', hidden: false }] }),
		},
		session: {
			get: () =>
				Effect.sync(() => {
					const snapshot = { id: sessionID, location: { directory }, agent, permissions: stored }
					if (pendingRace !== undefined) {
						stored = pendingRace
						published.push(pendingRace)
						pendingRace = undefined
					}
					return snapshot
				}),
			update: ({ permissions }: { readonly permissions: Permission.Ruleset }) =>
				Effect.sync(() => {
					stored = permissions
					published.push(permissions)
				}),
		},
	} as unknown as Pick<Plugin.Context, 'session' | 'agent' | 'location'>
	const policy = makeT3SessionPolicy(context)
	let handled = 0
	return {
		published,
		stored: () => stored,
		switchAgent: (next: string) => {
			agent = next
		},
		/** Handles published writes in order, as the plugin's event subscriber does: creation first. */
		handle: async (count = Number.POSITIVE_INFINITY) => {
			for (let processed = 0; processed < count && handled < published.length; processed++) {
				const recorded = published[handled] ?? []
				await Effect.runPromise(
					handled === 0 ? policy.reconcile(sessionID) : policy.repair(sessionID, recorded),
				)
				handled++
				if (published.length > 20) throw new Error('Permission repairs did not converge')
			}
		},
	}
}

const fullAccess = [rule('*', 'allow'), rule('read', 'allow', 'full/*'), ...anchors]
const plan = [rule('edit', 'ask'), rule('edit', 'allow', 'plan/*'), ...anchors]

test('repairs from each write’s own rules, so a racing T3 write is never lost', async () => {
	// T3 writes Full access, then Plan mode while the plugin repairs the first write.
	const session = fixture(fullAccess, plan)
	await session.handle()
	expect(session.stored()).toEqual(normalizeT3Permissions(plan, 'research'))
	expect(session.stored()).not.toContainEqual(rule('*', 'allow'))
})

test('a repair written for an earlier agent still ends the cycle', async () => {
	const session = fixture(fullAccess, plan)
	await session.handle(1)
	session.switchAgent('limitless')
	await session.handle()
	expect(session.stored()).toEqual(normalizeT3Permissions(plan, 'limitless'))
})

test('a native child created with its parent’s repaired rules receives its own role’s form', async () => {
	const inherited = normalizeT3Permissions(fullAccess, 'limitless')
	const session = fixture(inherited)
	await session.handle()
	expect(session.stored()).toEqual(normalizeT3Permissions(inherited, 'research'))
	expect(session.stored()).not.toEqual(inherited)
})

test('ignores sessions without T3 rules and its own repaired writes', async () => {
	const native = [rule('read', 'allow')]
	const session = fixture(native)
	await session.handle()
	session.published.push(normalizeT3Permissions(fullAccess, 'research'))
	await session.handle()
	expect(session.stored()).toEqual(native)
	expect(session.published).toHaveLength(2)
})
