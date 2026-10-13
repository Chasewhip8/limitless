import { Deferred, Effect, Fiber } from 'effect'
import { expect, test } from 'vitest'
import { withSessionPolicyLock } from '../t3/session-policy'

test('serializes a reconcile with a concurrent replacement without losing its grant', async () => {
	const history: string[] = []
	await Effect.runPromise(
		Effect.gen(function* () {
			const reading = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const first = yield* withSessionPolicyLock(
				'session-race',
				Effect.gen(function* () {
					history.push('reconcile read')
					yield* Deferred.succeed(reading, undefined)
					yield* Deferred.await(release)
					history.push('reconcile write')
				}),
			).pipe(Effect.forkChild)
			yield* Deferred.await(reading)
			const second = yield* withSessionPolicyLock(
				'session-race',
				Effect.sync(() => {
					history.push('replacement with grant')
				}),
			).pipe(Effect.forkChild)
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(first)
			yield* Fiber.join(second)
		}),
	)
	expect(history).toEqual(['reconcile read', 'reconcile write', 'replacement with grant'])
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
