import { Effect, Record, Redacted, Schema, Stream } from 'effect'
import { ChildProcess, type ChildProcessSpawner } from 'effect/process'
import { CapsuleError, type CapsuleSpec, type RuntimeSettings } from './schema'

const Environment = Schema.Record(Schema.String, Schema.String)

export const resolveEnvironment = Effect.fn('CapsuleEnvironment.resolve')(function* (
	spawner: ChildProcessSpawner.ChildProcessSpawner['Service'],
	settings: RuntimeSettings,
	spec: CapsuleSpec,
) {
	const handle = yield* spawner.spawn(
		ChildProcess.make(
			settings.nix,
			[
				'develop',
				'--no-update-lock-file',
				`${spec.directory}#${spec.project.devShell ?? 'default'}`,
				'--command',
				settings.shell,
				'-c',
				'exec "$1" -0 >&3',
				'capsule-environment',
				settings.env,
			],
			{
				cwd: spec.directory,
				stdin: 'ignore',
				additionalFds: { fd3: { type: 'output' } },
			},
		),
	)
	const [output, exitCode] = yield* Effect.all(
		[
			handle.getOutputFd(3).pipe(
				Stream.decodeText(),
				Stream.runFoldEffect(
					() => '',
					(text, chunk) => {
						if (text.length + chunk.length > 1_048_576) {
							return CapsuleError.make({
								code: 'environment_failed',
								message: 'The project environment exceeds the size limit.',
							})
						}
						return Effect.succeed(text + chunk)
					},
				),
			),
			handle.exitCode,
			Stream.runDrain(handle.all),
		],
		{ concurrency: 'unbounded' },
	)
	if (exitCode !== 0 || !output.endsWith('\0')) {
		return yield* CapsuleError.make({
			code: 'environment_failed',
			message: `The project development environment failed to load (exit ${exitCode}).`,
		})
	}
	const entries = output
		.slice(0, -1)
		.split('\0')
		.map((entry) => {
			const separator = entry.indexOf('=')
			return [entry.slice(0, separator), entry.slice(separator + 1)] as const
		})
	const environment = yield* Schema.decodeUnknownEffect(Environment)(
		Object.fromEntries(entries),
	).pipe(
		Effect.mapError(() =>
			CapsuleError.make({ code: 'environment_failed', message: 'Invalid project environment.' }),
		),
	)
	return Record.map(environment, (value) => Redacted.make(value))
}, Effect.scoped)

export const runProjectCommand = Effect.fn('CapsuleEnvironment.runProjectCommand')(function* (
	spawner: ChildProcessSpawner.ChildProcessSpawner['Service'],
	directory: string,
	args: readonly string[] | undefined,
	operation: 'setup' | 'stop' | 'purge',
) {
	if (!args) return
	const [executable, ...arguments_] = args
	if (!executable) {
		return yield* CapsuleError.make({
			code: 'invalid_input',
			message: 'An executable is required.',
		})
	}
	const exitCode = yield* spawner.exitCode(
		ChildProcess.make(executable, arguments_, { cwd: directory, stdin: 'ignore' }),
	)
	if (exitCode !== 0) {
		return yield* CapsuleError.make({
			code: operation === 'setup' ? 'bootstrap_failed' : 'command_failed',
			message: `The repository ${operation} command failed (exit ${exitCode}).`,
		})
	}
})
