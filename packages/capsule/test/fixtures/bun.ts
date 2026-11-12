import { Effect, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

const stderrLimit = 20_000

/**
 * Runs a TypeScript fixture under the development shell's Bun, the pinned runtime of embedding
 * hosts, with `input` as its JSON argument, and returns its standard output. A fixture that fails
 * or outlives `deadline` dies with the tail of its standard error once it has been stopped.
 */
export const runBunFixture = Effect.fn('runBunFixture')(function* (
	fixture: string,
	input: unknown,
	options: { readonly env: Readonly<Record<string, string>>; readonly deadline: number },
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const handle = yield* spawner.spawn(
		ChildProcess.make('bun', [fixture, JSON.stringify(input)], {
			env: options.env,
			extendEnv: false,
			stdin: 'ignore',
			forceKillAfter: '5 seconds',
		}),
	)
	let stderr = ''
	const [stdout, exitCode] = yield* Effect.all(
		[
			Stream.mkString(Stream.decodeText(handle.stdout)),
			handle.exitCode,
			Stream.runForEach(Stream.decodeText(handle.stderr), (chunk) =>
				Effect.sync(() => {
					stderr = (stderr + chunk).slice(-stderrLimit)
				}),
			),
		],
		{ concurrency: 'unbounded' },
	).pipe(
		Effect.timeoutOrElse({
			duration: options.deadline,
			orElse: () => Effect.die(new Error(`Bun fixture did not exit:\n${stderr}`)),
		}),
	)
	if (exitCode !== 0) return yield* Effect.die(new Error(`Bun fixture failed:\n${stderr}`))
	return stdout
}, Effect.scoped)
