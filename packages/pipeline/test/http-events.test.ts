import { Effect, Fiber, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { expect, test } from 'vitest'
import { commandEventBody } from '../http-events'

test('idle event bodies heartbeat every 15 seconds without querying task state', async () => {
	const lines = await Effect.runPromise(
		Effect.gen(function* () {
			const body = yield* commandEventBody(Stream.never).pipe(
				Stream.take(2),
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
	expect(lines.bytes.map((bytes) => new TextDecoder().decode(bytes))).toEqual(['\n', '\n'])
})

test('settled event bodies stop their heartbeat instead of keeping the response open', async () => {
	const bytes = await Effect.runPromise(commandEventBody(Stream.empty).pipe(Stream.runCollect))
	expect(bytes).toEqual([])
})
