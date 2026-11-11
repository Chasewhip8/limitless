import { createHash } from 'node:crypto'
import { Context, Effect, Queue, Schema, Semaphore, Stream } from 'effect'
import { makeSupervisor, SupervisorEnvironment } from './lock-supervisor'
import { WorkspaceError } from './schema'

const Event = Schema.Union([
	Schema.TaggedStruct('Locked', {}),
	Schema.TaggedStruct('Output', { bytes: Schema.String }),
	Schema.TaggedStruct('Exited', { code: Schema.Int }),
	Schema.TaggedStruct('Closed', {}),
])
type Event = typeof Event.Type

const makeSession = Effect.fn('WorkspaceProcess.makeSession')(function* (
	file: string,
	env: NodeJS.ProcessEnv,
) {
	const handle = yield* makeSupervisor(file, env)
	const events = yield* Queue.bounded<Event, 'Closed'>(16)
	const next = Queue.take(events).pipe(
		Effect.catch(() => Effect.succeed({ _tag: 'Closed' } as const)),
	)
	yield* Stream.runForEach(Stream.splitLines(Stream.decodeText(handle.stdout)), (line) =>
		Effect.gen(function* () {
			const event = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Event))(line)
			yield* Queue.offer(events, event)
		}),
	).pipe(Effect.ignore, Effect.ensuring(Queue.fail(events, 'Closed')), Effect.forkScoped)
	const acquired = yield* next
	if (acquired._tag !== 'Locked') {
		const exit = yield* handle.exitCode
		if (exit === 73)
			return yield* WorkspaceError.make({
				code: 'busy',
				message: 'Another workspace operation holds the process lock.',
			})
		return yield* WorkspaceError.make({
			code: 'io_failed',
			message: 'The workspace process lock failed.',
		})
	}
	const sequential = yield* Semaphore.make(1)
	const run = Effect.fn('WorkspaceProcess.runLocked')(
		function* (
			executable: string,
			args: ReadonlyArray<string>,
			code: 'git_failed' | 'archive_failed',
			cwd?: string,
			mode: 'text' | 'sha256' = 'text',
		) {
			const request = {
				executable,
				args,
				cwd,
				env: {
					GIT_TERMINAL_PROMPT: '0',
					GIT_OPTIONAL_LOCKS: '0',
					LC_ALL: 'C',
					GIT_DIR: null,
					GIT_WORK_TREE: null,
					GIT_COMMON_DIR: null,
					GIT_INDEX_FILE: null,
					GIT_OBJECT_DIRECTORY: null,
					GIT_ALTERNATE_OBJECT_DIRECTORIES: null,
					GIT_CONFIG: null,
					GIT_CONFIG_PARAMETERS: null,
					GIT_CONFIG_COUNT: null,
					GIT_NAMESPACE: null,
					GIT_SHALLOW_FILE: null,
					TAR_OPTIONS: null,
				},
			}
			yield* Stream.run(
				Stream.make(new TextEncoder().encode(`${JSON.stringify(request)}\n`)),
				handle.stdin,
			)
			const chunks: Array<Uint8Array> = []
			const digest = createHash('sha256')
			while (true) {
				const event = yield* next
				switch (event._tag) {
					case 'Output': {
						const bytes = Buffer.from(event.bytes, 'base64')
						if (mode === 'sha256') digest.update(bytes)
						else chunks.push(bytes)
						break
					}
					case 'Exited':
						if (event.code !== 0)
							return yield* WorkspaceError.make({
								code,
								message: 'A workspace command failed; recoverable files were retained.',
							})
						return mode === 'sha256'
							? digest.digest('hex')
							: Buffer.concat(chunks).toString('utf8').trim()
					case 'Closed':
					case 'Locked':
						return yield* WorkspaceError.make({
							code,
							message: 'The workspace command supervisor stopped before completion.',
						})
				}
			}
		},
		Effect.onInterrupt(() => handle.kill().pipe(Effect.ignore)),
		sequential.withPermit,
	)
	return { run }
})

class Session extends Context.Service<Session, Effect.Success<ReturnType<typeof makeSession>>>()(
	'pipeline/workspace/ProcessSession',
) {}

export const makeProcesses = Effect.gen(function* () {
	const env = yield* SupervisorEnvironment
	const run = Effect.fn('WorkspaceProcess.run')(function* (
		executable: string,
		args: ReadonlyArray<string>,
		code: 'git_failed' | 'archive_failed',
		cwd?: string,
		mode: 'text' | 'sha256' = 'text',
	) {
		const session = yield* Session
		return yield* session.run(executable, args, code, cwd, mode)
	})
	const git = (args: ReadonlyArray<string>, cwd?: string) =>
		run(
			'git',
			[
				'-c',
				'core.hooksPath=/dev/null',
				'-c',
				'core.fsmonitor=false',
				'-c',
				'core.untrackedCache=false',
				'-c',
				'gc.auto=0',
				'-c',
				'maintenance.auto=false',
				...args,
			],
			'git_failed',
			cwd,
		)
	const withLock = Effect.fn('WorkspaceProcess.withLock')(function* <A, E, R>(
		file: string,
		operation: Effect.Effect<A, E, R>,
	) {
		const session = yield* makeSession(file, env)
		return yield* operation.pipe(Effect.provideService(Session, session))
	}, Effect.scoped)
	return { run, git, withLock }
})
export type Processes = Effect.Success<typeof makeProcesses>
