import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Console, Effect } from 'effect'
import { Command, Flag } from 'effect/cli'
import { loadPipelineConfig } from './config'
import { inspectLegacy, migrateLegacy } from './migration'
import { runPipeline } from './server'

const config = Flag.String('config').pipe(
	Flag.withDescription('Absolute path to the Pipeline JSON configuration.'),
)

const serve = Command.make(
	'serve',
	{ config },
	Effect.fn('PipelineCli.serve')(function* ({ config }) {
		const settings = yield* loadPipelineConfig(config)
		yield* runPipeline(settings)
	}),
).pipe(Command.withDescription('Run the authenticated task API, scheduler, and reconciler.'))

const inspect = Command.make(
	'inspect',
	{ config },
	Effect.fn('PipelineCli.legacyInspect')(function* ({ config }) {
		const settings = yield* loadPipelineConfig(config)
		const report = yield* inspectLegacy(settings)
		yield* Console.log(JSON.stringify(report, null, 2))
	}),
).pipe(
	Command.withDescription(
		'Read-only: print the legacy snapshot digest, task and command identifiers, and delivery states.',
	),
)

const migrate = Command.make(
	'migrate',
	{
		config,
		plan: Flag.String('plan').pipe(
			Flag.withDescription('Reviewed migration plan JSON naming the inspected snapshot digest.'),
		),
		backup: Flag.String('backup').pipe(
			Flag.withDescription('New file for an online SQLite backup taken before conversion.'),
		),
	},
	Effect.fn('PipelineCli.legacyMigrate')(function* ({ config, plan, backup }) {
		const settings = yield* loadPipelineConfig(config)
		const report = yield* migrateLegacy(settings, { plan, backup })
		yield* Console.log(JSON.stringify(report, null, 2))
	}),
).pipe(
	Command.withDescription(
		'Back up and convert a stopped legacy database with a reviewed plan in one migration transaction.',
	),
)

const legacy = Command.make('legacy').pipe(
	Command.withSubcommands([inspect, migrate]),
	Command.withDescription('Inspect or convert released 0001 dispatch state.'),
)

const cli = Command.make('pipeline').pipe(
	Command.withSubcommands([serve, legacy]),
	Command.run({ version: '0.1.0' }),
)

Effect.gen(function* () {
	yield* Effect.sync(() => process.umask(0o077))
	yield* cli
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
