import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { NodeServices } from '@effect/platform-node'
import { Deferred, Effect, Fiber } from 'effect'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { acquireLock, type LockMode, type LockOptions, withLock } from '../lock'

const executable = (name: string) => {
	for (const directory of (process.env.PATH ?? '').split(delimiter)) {
		const candidate = join(directory, name)
		try {
			accessSync(candidate, constants.X_OK)
			return candidate
		} catch {}
	}
	throw new Error(`${name} is not on PATH`)
}

const shell = executable('sh')
const flock = executable('flock')
const sleep = executable('sleep')

let directory: string

beforeEach(async () => {
	await mkdir('/tmp/opencode', { recursive: true })
	directory = await mkdtemp('/tmp/opencode/capsule-lock-')
})

afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})

const options = (mode: LockMode, overrides: Partial<LockOptions> = {}): LockOptions => ({
	path: join(directory, 'capsule.lock'),
	mode,
	flock,
	shell,
	...overrides,
})

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

const probe = (mode: LockMode) =>
	Effect.scoped(acquireLock(options(mode))).pipe(
		Effect.as('acquired' as const),
		Effect.catchTag('LockBusy', () => Effect.succeed('busy' as const)),
	)

// Runs the real flock, then records the holder shell's pid and lingers so the
// lock is held before the holder announces readiness.
const instrumentedFlock = async (linger: string) => {
	const path = join(directory, 'flock')
	await writeFile(
		path,
		`#!${shell}\n'${flock}' "$@" || exit\necho "$PPID" > '${join(directory, 'holder.pid')}'\nexec '${sleep}' ${linger}\n`,
	)
	await chmod(path, 0o755)
	return path
}

const awaitHolderPid = Effect.promise(async () => {
	for (;;) {
		const pid = await readFile(join(directory, 'holder.pid'), 'utf8').catch(() => '')
		if (pid.trim()) return Number(pid)
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
})

test('shared holders coexist and exclude an exclusive holder', async () => {
	const outcome = await run(
		Effect.scoped(
			Effect.gen(function* () {
				yield* acquireLock(options('shared'))
				yield* acquireLock(options('shared'))
				return yield* probe('exclusive')
			}),
		),
	)
	expect(outcome).toBe('busy')
})

test('an exclusive lock is not reentrant and is released with its scope', async () => {
	const outcomes = await run(
		Effect.gen(function* () {
			const whileHeld = yield* Effect.scoped(
				Effect.gen(function* () {
					yield* acquireLock(options('exclusive'))
					return yield* Effect.flip(acquireLock(options('exclusive')))
				}),
			)
			return [whileHeld._tag, yield* probe('exclusive')]
		}),
	)
	expect(outcomes).toEqual(['LockBusy', 'acquired'])
})

test('interrupting a holder releases the lock', async () => {
	const outcome = await run(
		Effect.gen(function* () {
			const held = yield* Deferred.make<void>()
			const fiber = yield* Effect.forkChild(
				withLock(
					options('exclusive'),
					Effect.andThen(Deferred.succeed(held, undefined), Effect.never),
				),
			)
			yield* Deferred.await(held)
			yield* Fiber.interrupt(fiber)
			return yield* probe('exclusive')
		}),
	)
	expect(outcome).toBe('acquired')
})

test('an acquisition interrupted after locking releases before its scope closes', async () => {
	const slowFlock = await instrumentedFlock('30')
	const outcome = await run(
		Effect.scoped(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					acquireLock(options('exclusive', { flock: slowFlock })),
				)
				yield* awaitHolderPid
				const whileLocking = yield* probe('shared')
				yield* Fiber.interrupt(fiber)
				return [whileLocking, yield* probe('exclusive')]
			}),
		),
	)
	expect(outcome).toEqual(['busy', 'acquired'])
})

test('holder death interrupts guarded work with LockLost', async () => {
	const lingeringFlock = await instrumentedFlock('0')
	const outcome = await run(
		Effect.gen(function* () {
			const guarded = yield* Deferred.make<void>()
			const fiber = yield* Effect.forkChild(
				Effect.flip(
					withLock(
						options('exclusive', { flock: lingeringFlock }),
						Effect.andThen(Deferred.succeed(guarded, undefined), Effect.never),
					),
				),
			)
			yield* Deferred.await(guarded)
			process.kill(yield* awaitHolderPid, 'SIGKILL')
			const error = yield* Fiber.join(fiber)
			return [error._tag, yield* probe('exclusive')]
		}),
	)
	expect(outcome).toEqual(['LockLost', 'acquired'])
})

test('guarded work keeps its own failure', async () => {
	const error = await run(
		Effect.flip(withLock(options('shared'), Effect.fail('original' as const))),
	)
	expect(error).toBe('original')
})

test('an unopenable lock file fails without reporting busy', async () => {
	const error = await run(
		Effect.flip(
			Effect.scoped(
				acquireLock(options('shared', { path: join(directory, 'missing', 'capsule.lock') })),
			),
		),
	)
	expect(error).toMatchObject({
		_tag: 'LockFailed',
		message: expect.stringMatching(/exited with code 71/),
	})
})
