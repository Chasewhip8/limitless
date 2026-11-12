import { NodeSocketServer } from '@effect/platform-node'
import { Deferred, Effect, Option, Ref, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { Socket } from 'effect/socket'

/** Host Git with no user or system configuration, for building fixture repositories. */
export const makeHostGit = (home: string) => {
	const environment = {
		PATH: process.env.PATH ?? '',
		HOME: home,
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_TERMINAL_PROMPT: '0',
		GIT_AUTHOR_NAME: 'Fixture',
		GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
		GIT_COMMITTER_NAME: 'Fixture',
		GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
	}
	const git = Effect.fn('HostGit.run')(function* (args: ReadonlyArray<string>) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const handle = yield* spawner.spawn(
			ChildProcess.make('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
				env: environment,
				extendEnv: false,
				stdin: 'ignore',
			}),
		)
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[
				Stream.mkString(Stream.decodeText(handle.stdout)),
				Stream.mkString(Stream.decodeText(handle.stderr)),
				handle.exitCode,
			],
			{ concurrency: 'unbounded' },
		)
		if (exitCode !== 0) return yield* Effect.die(`git ${args.join(' ')} failed: ${stderr}`)
		return stdout.trimEnd()
	}, Effect.scoped)
	return { environment, git }
}

interface Gate {
	readonly after: number
	readonly waiting: Deferred.Deferred<void>
	readonly resumed: Deferred.Deferred<void>
}

/**
 * Serves the bare repositories below `directory` over `git://` on loopback, running one
 * `git daemon --inetd` per connection, until the enclosing scope closes. Sandboxed commands share
 * the host network, so they reach it where `file://` remotes would be unmounted.
 */
export const serveGit = Effect.fn('GitDaemon.serve')(function* (
	directory: string,
	environment: Readonly<Record<string, string>>,
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const server = yield* NodeSocketServer.make({ host: '127.0.0.1', port: 0 })
	if (server.address._tag !== 'InetAddressV4')
		return yield* Effect.die('The Git daemon fixture must listen on IPv4 loopback')
	const { port } = server.address
	const connections = yield* Ref.make(0)
	const reachable = yield* Ref.make(true)
	const gate = yield* Ref.make(Option.none<Gate>())

	const serveConnection = Effect.fn('GitDaemon.connection')(
		function* (socket: Socket.Socket) {
			// An unreachable remote closes each connection unanswered, so Git fails as if offline.
			// Only acquiring the reader opens the paused socket; releasing it closes the connection.
			if (!(yield* Ref.get(reachable))) return yield* Effect.scoped(socket.reader)
			const index = yield* Ref.getAndUpdate(connections, (count) => count + 1)
			const held = Option.filter(yield* Ref.get(gate), ({ after }) => index >= after)
			if (Option.isSome(held)) {
				yield* Deferred.succeed(held.value.waiting, undefined)
				// Closing the scope closes a still-held connection, so the server can finish closing.
				yield* Deferred.await(held.value.resumed).pipe(
					Effect.onInterrupt(() => Effect.scoped(socket.reader).pipe(Effect.ignore)),
				)
			}
			const daemon = yield* spawner.spawn(
				ChildProcess.make(
					'git',
					[
						'daemon',
						'--inetd',
						'--export-all',
						'--informative-errors',
						'--log-destination=none',
						`--base-path=${directory}`,
					],
					{ env: environment, extendEnv: false, stderr: 'ignore' },
				),
			)
			// Releasing the writer half-closes the connection once the daemon finishes responding.
			const respond = Effect.gen(function* () {
				const writer = yield* socket.writer
				yield* Stream.runForEach(daemon.stdout, writer.write)
			}).pipe(Effect.scoped)
			const forward = Stream.run(Socket.toStream(socket), daemon.stdin).pipe(Effect.ignore)
			yield* Effect.all([forward, respond, daemon.exitCode], { concurrency: 'unbounded' })
		},
		(connection) => connection.pipe(Effect.scoped, Effect.ignore),
	)
	yield* server.run(serveConnection).pipe(Effect.forkScoped)

	/**
	 * Holds every connection after the first `after` served ones without answering, so its Git
	 * client blocks mid-operation until `resume`. `waiting` completes once one is held.
	 */
	const pause = Effect.fn('GitDaemon.pause')(function* (after: number) {
		const waiting = yield* Deferred.make<void>()
		const resumed = yield* Deferred.make<void>()
		yield* Ref.set(gate, Option.some({ after, waiting, resumed }))
		return {
			waiting: Deferred.await(waiting),
			resume: Deferred.succeed(resumed, undefined).pipe(Effect.asVoid),
		}
	})

	return {
		/** Prefix of every repository URL, which is `<prefix><owner/repo>.git`. */
		prefix: `git://127.0.0.1:${port}/`,
		url: (repository: string) => `git://127.0.0.1:${port}/${repository}.git`,
		/** Accepted connections, each one remote Git operation such as `ls-remote` or `fetch`. */
		connections: Ref.get(connections),
		disconnect: Ref.set(reachable, false),
		reconnect: Ref.set(reachable, true),
		pause,
	}
})
