import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Config, Console, Effect, FileSystem, Option, Path, Schema } from 'effect'
import { Argument, Command, Flag } from 'effect/cli'
import { ChildProcess } from 'effect/process'
import { CapsuleError, CapsuleId, Project, RuntimeSettings } from './schema'
import { make } from './service'

const root = Command.make('capsule').pipe(
	Command.withSharedFlags({
		root: Flag.String('root').pipe(
			Flag.withFallbackConfig(Config.String('CAPSULE_ROOT')),
			Flag.withDescription('Dedicated absolute state directory, outside every source checkout.'),
		),
		runtime: Flag.String('runtime').pipe(
			Flag.withFallbackConfig(Config.String('CAPSULE_RUNTIME_CONFIG')),
			Flag.withDescription('Pinned runtime JSON supplied by the Capsule Nix package.'),
		),
	}),
	Command.withDescription('Prepare and execute retained Nix environments through Bubblewrap.'),
)

const service = Effect.fn('CapsuleCli.service')(function* () {
	const options = yield* root
	const fs = yield* FileSystem.FileSystem
	const json = yield* fs.readFileString(options.runtime)
	const runtime = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeSettings))(
		json,
	).pipe(
		Effect.mapError(() =>
			CapsuleError.make({
				code: 'invalid_input',
				message: 'Invalid Capsule runtime configuration.',
			}),
		),
	)
	return yield* make({ root: options.root, runtime })
})

const idArgument = Argument.String('id').pipe(Argument.withSchema(CapsuleId))

const prepare = Command.make(
	'prepare',
	{
		directory: Argument.String('directory'),
		id: Flag.String('id').pipe(Flag.withSchema(CapsuleId)),
		dockerSocket: Flag.String('docker-socket').pipe(
			Flag.withDescription('Existing host Docker Unix socket to expose; no daemon is created.'),
			Flag.optional,
		),
		refresh: Flag.Boolean('refresh').pipe(
			Flag.withDescription('Reload the development environment and rerun idempotent setup.'),
			Flag.withDefault(false),
		),
	},
	Effect.fn('CapsuleCli.prepare')(function* ({ directory: input, id, dockerSocket, refresh }) {
		const capsule = yield* service()
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const directory = yield* fs.realPath(input)
		const configFile = path.join(directory, 'capsule.json')
		const project = yield* Effect.gen(function* () {
			if (!(yield* fs.exists(configFile))) return {}
			const json = yield* fs.readFileString(configFile)
			return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Project))(json).pipe(
				Effect.mapError(() =>
					CapsuleError.make({ code: 'invalid_input', message: 'Invalid repository capsule.json.' }),
				),
			)
		})
		const manifest = yield* capsule.prepare(
			{
				id,
				directory,
				project,
				...(Option.isSome(dockerSocket) ? { dockerSocket: dockerSocket.value } : {}),
			},
			refresh,
		)
		yield* Console.log(JSON.stringify(manifest))
	}),
).pipe(
	Command.withDescription(
		'Prepare an existing checkout using its flake and optional capsule.json.',
	),
)

const exec = Command.make(
	'exec',
	{
		id: idArgument,
		command: Argument.String('command').pipe(Argument.variadic({ min: 1 })),
		cwd: Flag.String('cwd').pipe(Flag.optional),
	},
	Effect.fn('CapsuleCli.exec')(function* ({ id, command, cwd }) {
		const capsule = yield* service()
		const manifest = yield* capsule.inspect(id)
		if (!manifest) {
			return yield* CapsuleError.make({
				code: 'not_prepared',
				message: 'The Capsule does not exist.',
			})
		}
		const spawner = yield* capsule.connect(id)
		const [executable, ...args] = command
		if (!executable) {
			return yield* CapsuleError.make({ code: 'invalid_input', message: 'A command is required.' })
		}
		const code = yield* spawner.exitCode(
			ChildProcess.make(executable, args, {
				cwd: Option.getOrElse(cwd, () => manifest.spec.directory),
				stdin: 'inherit',
				stdout: 'inherit',
				stderr: 'inherit',
			}),
		)
		yield* Effect.sync(() => {
			process.exitCode = code
		})
	}),
).pipe(Command.withDescription('Run a command in a prepared Capsule; use -- before command flags.'))

const lifecycle = (operation: 'inspect' | 'stop' | 'purge', description: string) =>
	Command.make(
		operation,
		{ id: idArgument },
		Effect.fn(`CapsuleCli.${operation}`)(function* ({ id }) {
			const capsule = yield* service()
			const result = yield* capsule[operation](id)
			yield* Console.log(JSON.stringify(result ?? null))
		}),
	).pipe(Command.withDescription(description))

const cli = root.pipe(
	Command.withSubcommands([
		prepare,
		exec,
		lifecycle('inspect', 'Read retained Capsule metadata.'),
		lifecycle('stop', 'Stop repository services while retaining its checkout and data.'),
		lifecycle(
			'purge',
			'Destroy owned runtime data and run repository teardown; retain the source checkout.',
		),
	]),
	Command.run({ version: '0.1.0' }),
)

Effect.gen(function* () {
	yield* Effect.sync(() => process.umask(0o077))
	yield* cli
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
