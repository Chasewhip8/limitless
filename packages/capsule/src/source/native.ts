import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { NodeStream } from '@effect/platform-node'
import { Deferred, Effect, Exit, Result, type Stream } from 'effect'
import { SourceError } from './schema'

// Effect 4.1.3's spawner only exposes pipes for additional descriptors, not existing ones, so this
// module is the boundary that passes the open lock description to child processes. Bun 1.3 closes
// the caller's descriptors passed as extra numeric stdio (fd 3 and above), but only borrows numeric
// stdin, stdout, and stderr; the lock therefore crosses this boundary as stdin.

export interface NativeCommand {
	readonly executable: string
	readonly args: ReadonlyArray<string>
	readonly cwd?: string | undefined
	/** The command's complete environment, which may hold secrets; it never enters arguments. */
	readonly env: Readonly<Record<string, string>>
}

/**
 * Carries a command's environment through its Node trampoline, which runs in the helper's own
 * environment so that variables such as `NODE_OPTIONS` reach only the command.
 */
export const commandEnvironmentVariable = 'LIMITLESS_SOURCE_COMMAND_ENVIRONMENT'

// Linux limits each environment string, `NAME=value` and its terminating NUL, to 128 KiB.
const commandEnvironmentLimit = 120 * 1024

const ioFailure = () =>
	SourceError.make({ code: 'io_failed', message: 'The source process boundary failed.' })

const busyExitCode = 73

/**
 * Starts a child whose exit and close are observed from the moment it exists. Bun throws spawn
 * failures synchronously where Node emits `error`, so both fail here.
 *
 * Interrupting startup, or `stop`, signals the child, waits until it has been reaped, and then
 * destroys this process's ends of its pipes. A detached child leads a process group whose members
 * can outlive it while holding those pipes, so the group is signaled until the pipes have closed,
 * even after the leader has exited; once they have closed, its id may have been reused and it is
 * never signaled. Destroying the pipes last keeps them from closing before that decision.
 */
const spawnNative = Effect.fn('SourceNative.spawn')(function* (
	file: string,
	args: ReadonlyArray<string>,
	options: SpawnOptions,
) {
	const exited = yield* Deferred.make<void>()
	const closed = yield* Deferred.make<number | null>()
	const stop = (child: ChildProcess) =>
		Effect.gen(function* () {
			const pid = child.pid
			const finished = options.detached ? Deferred.isDone(closed) : Deferred.isDone(exited)
			if (pid !== undefined && !(yield* finished))
				yield* Effect.try({
					try: () => process.kill(options.detached ? -pid : pid, 'SIGTERM'),
					catch: ioFailure,
				}).pipe(Effect.ignore)
			yield* Deferred.await(exited)
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe?.destroy()
				}),
			),
		)
	const child = yield* Effect.callback<ChildProcess, SourceError>((resume) => {
		const started = Result.try(() => spawn(file, args, options))
		if (Result.isFailure(started)) {
			resume(Effect.fail(ioFailure()))
			return
		}
		const child = started.success
		child.once('spawn', () => resume(Effect.succeed(child)))
		child.once('exit', () => {
			resume(Effect.succeed(child))
			Deferred.doneUnsafe(exited, Exit.void)
		})
		child.once('close', (code) => Deferred.doneUnsafe(closed, Exit.succeed(code)))
		child.on('error', () => {
			// A child that never started has no exit or close to wait for.
			if (child.pid === undefined) {
				Deferred.doneUnsafe(exited, Exit.void)
				Deferred.doneUnsafe(closed, Exit.succeed(null))
			}
			resume(Effect.fail(ioFailure()))
		})
		return stop(child)
	})
	return {
		child,
		/** Exit code once the child has exited and its stdio has closed; `null` when signaled. */
		closed: Deferred.await(closed),
		stop: () => stop(child),
	}
})

/** Opens `file` and takes its exclusive non-blocking `flock`, closing it with the scope. */
export const acquireLock = Effect.fn('SourceNative.acquireLock')(function* (
	file: string,
	flock: string,
	environment: Readonly<Record<string, string>>,
) {
	const handle = yield* Effect.acquireRelease(
		Effect.tryPromise({
			try: () => open(file, constants.O_RDONLY | constants.O_NOFOLLOW),
			catch: ioFailure,
		}),
		(handle) => Effect.promise(() => handle.close().catch(() => undefined)),
	)
	const holder = yield* spawnNative(
		flock,
		['--exclusive', '--nonblock', '--conflict-exit-code', String(busyExitCode), '0'],
		{ env: environment, stdio: [handle.fd, 'ignore', 'ignore'] },
	)
	const code = yield* holder.closed.pipe(Effect.onInterrupt(() => holder.stop()))
	if (code === busyExitCode)
		return yield* SourceError.make({
			code: 'busy',
			message: 'Another source operation holds the process lock.',
		})
	if (code !== 0) return yield* ioFailure()
	return handle
})

/**
 * Runs `command` through a Node trampoline in its own process group. The command inherits the
 * locked description as descriptor 3, and its standard output streams back. If this process dies,
 * the trampoline and its writers keep holding the lock; interrupting stops the whole group.
 */
export const runCommand = Effect.fn('SourceNative.runCommand')(function* (
	node: string,
	helperEnvironment: Readonly<Record<string, string>>,
	lock: FileHandle,
	command: NativeCommand,
	consume: (output: Stream.Stream<Uint8Array, SourceError>) => Effect.Effect<string, SourceError>,
) {
	const payload = JSON.stringify(command.env)
	const entryBytes = Buffer.byteLength(`${commandEnvironmentVariable}=${payload}`) + 1
	if (entryBytes > commandEnvironmentLimit)
		return yield* SourceError.make({
			code: 'io_failed',
			message: 'The source command environment exceeds the supported size.',
		})
	const trampoline = yield* Effect.acquireRelease(
		spawnNative(
			node,
			['-e', trampolineSource, JSON.stringify([command.executable, command.args, command.cwd])],
			{
				env: { ...helperEnvironment, [commandEnvironmentVariable]: payload },
				detached: true,
				stdio: [lock.fd, 'pipe', 'ignore'],
			},
		),
		(trampoline) => trampoline.stop(),
	)
	const stdout: Readable | null = trampoline.child.stdout
	if (stdout === null) return yield* ioFailure()
	// The trampoline's release, not this stream, destroys the pipe after signaling its group.
	const output = NodeStream.fromReadable({
		evaluate: () => stdout,
		onError: ioFailure,
		closeOnDone: false,
	})
	const [text, code] = yield* Effect.all([consume(output), trampoline.closed], {
		concurrency: 'unbounded',
	})
	return { text, code }
}, Effect.scoped)

// Keep executable source literal: bundlers rewrite require/import references inside serialized
// functions. Descriptor 0 is the lock and 1 the output pipe; the command sees its output on 1 and
// the lock on 3. Node's own diagnostics are discarded and failures exit without reporting, so the
// environment never reaches the output.
const trampolineSource = `
const { spawn } = require('node:child_process');
let child;
try {
 const [executable, args, cwd] = JSON.parse(process.argv[1]);
 const env = JSON.parse(process.env.${commandEnvironmentVariable});
 child = spawn(executable, args, { cwd: cwd ?? undefined, env, stdio: ['ignore', 1, 'ignore', 0] });
} catch { process.exit(125); }
child.on('error', () => {});
child.on('close', (code) => process.exit(code ?? 128));
`
