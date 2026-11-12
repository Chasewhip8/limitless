import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { Command, Flag } from 'effect/cli'
import { loadPipelineConfig } from './config'
import { runPipeline } from './server'

const serve = Command.make(
	'serve',
	{
		config: Flag.String('config').pipe(
			Flag.withDescription('Absolute path to the Pipeline JSON configuration.'),
		),
	},
	Effect.fn('PipelineCli.serve')(function* ({ config }) {
		const settings = yield* loadPipelineConfig(config)
		yield* runPipeline(settings)
	}),
).pipe(Command.withDescription('Run the authenticated task API, scheduler, and reconciler.'))

const cli = Command.make('pipeline').pipe(
	Command.withSubcommands([serve]),
	Command.run({ version: '0.1.0' }),
)

Effect.gen(function* () {
	yield* Effect.sync(() => process.umask(0o077))
	yield* cli
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
