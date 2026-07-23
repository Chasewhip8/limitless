import { watch } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Deferred, Effect, Fiber } from 'effect'
import { describe, expect, test } from 'vitest'
import { runCommand } from '../core/command'

describe('runCommand', () => {
	test('terminates the child process when its Effect fiber is interrupted', async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const directory = yield* Effect.acquireRelease(
						Effect.promise(() => mkdtemp(path.join(os.tmpdir(), 'limitless-command-'))),
						(directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
					)
					const marker = path.join(directory, 'ready')
					const ready = yield* Deferred.make<void>()
					yield* Effect.acquireRelease(
						Effect.sync(() =>
							watch(directory, (_event, file) => {
								if (file?.toString() === 'ready') Deferred.doneUnsafe(ready, Effect.void)
							}),
						),
						(watcher) => Effect.sync(() => watcher.close()),
					)
					const fiber = yield* runCommand(process.execPath, [
						'-e',
						"require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)",
						marker,
					]).pipe(Effect.forkChild)
					yield* Deferred.await(ready)
					yield* Fiber.interrupt(fiber)
					expect(true).toBe(true)
				}),
			),
		)
	})
})
