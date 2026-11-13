import { Effect, Fiber, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { expect, test } from 'vitest'
import { operationEventBody } from '../http-events'

test('event bodies open immediately and heartbeat every 15 seconds while the first view is unavailable', async () => {
	const lines = await Effect.runPromise(
		Effect.gen(function* () {
			const body = yield* operationEventBody(Stream.never).pipe(
				Stream.take(3),
				Stream.runCollect,
				Effect.forkChild,
			)
			yield* TestClock.adjust('29 seconds')
			const early = body.pollUnsafe()
			yield* TestClock.adjust('1 second')
			return { early, bytes: yield* Fiber.join(body) }
		}).pipe(Effect.provide(TestClock.layer())),
	)
	expect(lines.early).toBeUndefined()
	expect(lines.bytes.map((bytes) => new TextDecoder().decode(bytes))).toEqual(['\n', '\n', '\n'])
})

test('settled event bodies stop their heartbeat instead of keeping the response open', async () => {
	const bytes = await Effect.runPromise(operationEventBody(Stream.empty).pipe(Stream.runCollect))
	expect(bytes.map((bytes) => new TextDecoder().decode(bytes))).toEqual(['\n'])
})
