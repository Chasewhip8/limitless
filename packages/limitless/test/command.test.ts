import { watch } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Deferred, Effect, Fiber } from 'effect'
import { describe, test } from 'vitest'
import { runCommand } from '../core/command'

const longRunningChild = `
const fs = require('node:fs')
const [readyMarker, terminatedMarker] = process.argv.slice(1)
process.on('SIGTERM', () => {
	fs.writeFileSync(terminatedMarker, '')
	process.exit(0)
})
fs.writeFileSync(readyMarker, '')
setInterval(() => {}, 1000)
`

describe('runCommand', () => {
	test('terminates the child process when its Effect fiber is interrupted', async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const directory = yield* Effect.acquireRelease(
						Effect.promise(() => mkdtemp(path.join(os.tmpdir(), 'limitless-command-'))),
						(directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
					)
					const ready = yield* Deferred.make<void>()
					const terminated = yield* Deferred.make<void>()
					yield* Effect.acquireRelease(
						Effect.sync(() =>
							watch(directory, (_event, file) => {
								if (file?.toString() === 'ready') Deferred.doneUnsafe(ready, Effect.void)
								if (file?.toString() === 'terminated') Deferred.doneUnsafe(terminated, Effect.void)
							}),
						),
						(watcher) => Effect.sync(() => watcher.close()),
					)
					const fiber = yield* runCommand(process.execPath, [
						'-e',
						longRunningChild,
						path.join(directory, 'ready'),
						path.join(directory, 'terminated'),
					]).pipe(Effect.forkChild)
					yield* Deferred.await(ready)
					yield* Fiber.interrupt(fiber)
					yield* Deferred.await(terminated)
				}),
			),
		)
	})
})
