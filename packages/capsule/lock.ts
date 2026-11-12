import { Effect, Exit, Option, Schema, Scope, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

const Mode = Schema.Literals(['shared', 'exclusive'])

export type LockMode = typeof Mode.Type

export interface LockOptions {
	/**
	 * Lock file, opened for append and created when absent. Its directory must
	 * already exist, and it must not be removed or replaced while any process
	 * relies on the lock, so keep it outside directories that get purged.
	 */
	readonly path: string
	readonly mode: LockMode
	/** util-linux `flock`, preferably absolute; the holder runs with an empty environment. */
	readonly flock: string
	/** POSIX shell, preferably absolute; the holder runs with an empty environment. */
	readonly shell: string
}

export class LockBusy extends Schema.TaggedError<LockBusy>()('LockBusy', {
	path: Schema.String,
	mode: Mode,
}) {}

export class LockFailed extends Schema.TaggedError<LockFailed>()('LockFailed', {
	path: Schema.String,
	mode: Mode,
	message: Schema.String,
}) {}

export class LockLost extends Schema.TaggedError<LockLost>()('LockLost', {
	path: Schema.String,
	mode: Mode,
	message: Schema.String,
}) {}

export interface Lock {
	readonly path: string
	readonly mode: LockMode
	/**
	 * Fails with `LockLost` once the holder process exits; it never succeeds.
	 * Only meaningful while the acquiring scope is open: race it with work the
	 * lock protects, or use `guard`.
	 */
	readonly lost: Effect.Effect<never, LockLost>
	/** Runs `effect`, interrupting it and failing with `LockLost` if the lock is lost first. */
	readonly guard: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | LockLost, R>
}

const busyExitCode = 75
const readyToken = 'capsule-lock-ready'
const stderrLimit = 500

// Fixed holder protocol; all variable input arrives as positional arguments:
// $1 flock, $2 mode flag, $3 lock path. The lock belongs to fd 9's open file
// description, so it is held until the shell exits on stdin EOF (including the
// parent's death) or on the termination signal sent at scope finalization.
const holderScript = [
	'command exec 9>>"$3" || exit 71',
	`"$1" -n -E ${busyExitCode} "$2" 9 || exit`,
	`echo ${readyToken}`,
	'while IFS= read -r _; do :; done',
].join('\n')

const holderCommand = (options: LockOptions) =>
	ChildProcess.make(
		options.shell,
		[
			'-c',
			holderScript,
			'capsule-lock',
			options.flock,
			options.mode === 'shared' ? '-s' : '-x',
			options.path,
		],
		{ env: {}, extendEnv: false, forceKillAfter: '2 seconds' },
	)

/**
 * Acquires a non-blocking, non-reentrant cross-process `flock` held until the
 * current scope closes. A second acquisition that conflicts, even from this
 * process, fails with `LockBusy`. Interrupted or failed acquisitions release
 * the holder before returning.
 */
export const acquireLock = Effect.fn('Capsule.acquireLock')(function* (options: LockOptions) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const parent = yield* Effect.scope
	const lockScope = yield* Scope.fork(parent)

	return yield* holdLock(spawner, options).pipe(
		Scope.provide(lockScope),
		Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(lockScope, exit))),
	)
})

/** Runs `effect` while holding the lock, failing with `LockLost` if the holder dies first. */
export const withLock = <A, E, R>(options: LockOptions, effect: Effect.Effect<A, E, R>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const lock = yield* acquireLock(options)
			return yield* lock.guard(effect)
		}),
	)

const holdLock = Effect.fnUntraced(function* (
	spawner: ChildProcessSpawner.ChildProcessSpawner['Service'],
	options: LockOptions,
) {
	const { path, mode } = options
	const failed = (message: string) => LockFailed.make({ path, mode, message })
	const handle = yield* spawner
		.spawn(holderCommand(options))
		.pipe(Effect.mapError((error) => failed(`could not start lock holder: ${error.message}`)))

	const ready = yield* handle.stdout.pipe(
		Stream.decodeText(),
		Stream.splitLines,
		Stream.runHead,
		Effect.mapError((error) => failed(`could not read lock holder: ${error.message}`)),
	)
	if (Option.getOrUndefined(ready) !== readyToken) {
		return yield* holderRejection(handle, options)
	}

	const lost = Effect.gen(function* () {
		const { description } = yield* holderExit(handle)
		return yield* LockLost.make({ path, mode, message: `lock holder ${description}` })
	})
	const lock: Lock = {
		path,
		mode,
		lost,
		guard: (effect) => Effect.raceFirst(effect, lost),
	}
	return lock
})

const holderRejection = Effect.fnUntraced(function* (
	handle: ChildProcessSpawner.ChildProcessHandle,
	{ path, mode }: LockOptions,
) {
	const { code, description } = yield* holderExit(handle)
	if (code === busyExitCode) {
		return yield* LockBusy.make({ path, mode })
	}

	const stderr = yield* handle.stderr.pipe(
		Stream.decodeText(),
		Stream.mkString,
		Effect.orElseSucceed(() => ''),
	)
	const detail = stderr.trim().slice(0, stderrLimit)
	return yield* LockFailed.make({
		path,
		mode,
		message: `lock holder ${description}${detail ? `: ${detail}` : ''}`,
	})
})

const holderExit = (handle: ChildProcessSpawner.ChildProcessHandle) =>
	Effect.match(handle.exitCode, {
		onSuccess: (code) => ({ code, description: `exited with code ${code}` }),
		onFailure: (error) => ({ code: undefined, description: `failed: ${error.message}` }),
	})
