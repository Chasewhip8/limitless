import { spawn, spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { NodeSink, NodeStream } from '@effect/platform-node'
import { Context, Deferred, Effect, Exit } from 'effect'
import { WorkspaceError } from './schema'
import { workspaceSupervisorSource } from './supervisor'

export class SupervisorEnvironment extends Context.Reference<NodeJS.ProcessEnv>(
	'pipeline/workspace/SupervisorEnvironment',
	{
		defaultValue: () => process.env,
	},
) {}

const ioFailure = () =>
	WorkspaceError.make({ code: 'io_failed', message: 'The workspace process boundary failed.' })

export const makeSupervisor = Effect.fn('WorkspaceProcess.makeSupervisor')(function* (
	file: string,
	env: NodeJS.ProcessEnv,
) {
	// Effect 4.1.3's spawner only exposes pipes for additional descriptors, not existing descriptors.
	// This boundary duplicates one open description into flock, the supervisor, and its writers;
	// the filesystem-owning helper retains its original descriptor throughout the operation.
	const lock = yield* Effect.acquireRelease(
		Effect.tryPromise({
			try: () => open(file, constants.O_RDWR | constants.O_NOFOLLOW),
			catch: ioFailure,
		}),
		(handle) =>
			Effect.tryPromise({ try: () => handle.close(), catch: ioFailure }).pipe(Effect.orDie),
	)
	const acquired = yield* Effect.try({
		try: () =>
			spawnSync('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'], {
				env,
				stdio: ['ignore', 'ignore', 'ignore', lock.fd],
			}),
		catch: ioFailure,
	})
	if (acquired.status === 73)
		return yield* WorkspaceError.make({
			code: 'busy',
			message: 'Another workspace operation holds the process lock.',
		})
	if (acquired.status !== 0) return yield* ioFailure()

	const exited = yield* Deferred.make<number>()
	const terminate = Effect.fn('WorkspaceProcess.terminateSupervisor')(function* (
		child: ReturnType<typeof spawn>,
	) {
		const pid = child.pid
		if (pid !== undefined && !(yield* Deferred.isDone(exited))) {
			yield* Effect.try({ try: () => process.kill(-pid, 'SIGTERM'), catch: ioFailure }).pipe(
				Effect.ignore,
			)
		}
		yield* Deferred.await(exited)
	})
	const child = yield* Effect.acquireRelease(
		Effect.callback<ReturnType<typeof spawn>, WorkspaceError>((resume) => {
			const child = spawn('node', ['-e', workspaceSupervisorSource], {
				env,
				detached: true,
				stdio: ['pipe', 'pipe', 'ignore', lock.fd],
			})
			child.once('spawn', () => resume(Effect.succeed(child)))
			child.on('error', () => resume(Effect.fail(ioFailure())))
			child.once('exit', (code) => Deferred.doneUnsafe(exited, Exit.succeed(code ?? 1)))
			return Effect.sync(() => {
				child.kill('SIGTERM')
			})
		}),
		terminate,
	)
	const stdin = child.stdin
	const stdout = child.stdout
	if (stdin === null || stdout === null) return yield* ioFailure()
	return {
		stdin: NodeSink.fromWritable({ evaluate: () => stdin, onError: ioFailure, endOnDone: false }),
		stdout: NodeStream.fromReadable({ evaluate: () => stdout, onError: ioFailure }),
		exitCode: Deferred.await(exited),
		kill: () => terminate(child),
	}
})
