import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Effect } from 'effect'
import { Command, Flag } from 'effect/cli'
import { printOpenCodeVersion, runLauncher, serveBridge } from '../bridge/launcher'
import { t3Client } from './bridge'

export { startT3Bridge } from './bridge'

const launcherName = 'opencode-t3'

const serve = Command.make(
	'serve',
	{
		hostname: Flag.String('hostname').pipe(Flag.withDefault('127.0.0.1')),
		port: Flag.Int('port').pipe(Flag.withDefault(0)),
	},
	({ hostname, port }) => serveBridge({ ...t3Client, launcher: launcherName, hostname, port }),
).pipe(
	Command.withDescription(
		'Serve T3’s OpenCode API from the managed OpenCode service. Set opencode-t3 as T3’s OpenCode Binary path and leave Server URL blank.',
	),
)

const launcher = Command.make(launcherName).pipe(Command.withSubcommands([serve]))

const main = Effect.gen(function* () {
	const args = process.argv.slice(2)
	if (args.length === 1 && (args[0] === '--version' || args[0] === '-v'))
		return yield* printOpenCodeVersion(launcherName)
	return yield* Command.runWith(launcher, { version: 'limitless' })(args)
})

// Importing the bundle (as the runtime checks do) must not start the launcher.
if (
	process.argv[1] !== undefined &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
	runLauncher(launcherName, main)
