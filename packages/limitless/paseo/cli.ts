import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Effect } from 'effect'
import { Command, Flag } from 'effect/cli'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { LauncherError, openCodeExecutable, runLauncher, serveBridge } from '../bridge/launcher'
import { paseoClient } from './bridge'
import { registerToolBridge } from './registration'

export { startPaseoBridge } from './bridge'

const launcherName = 'opencode-paseo'

/** Promise-facing registration for JavaScript callers such as integration tests. */
export const registerPaseoToolBridge = (environment: NodeJS.ProcessEnv) =>
	Effect.runPromise(registerToolBridge(environment))

/**
 * Everything except `serve` is OpenCode's own CLI: Paseo probes `--version`
 * and runs diagnostics such as `auth list`. Paseo's server credentials stay out
 * of those commands.
 */
const passThrough = (args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const executable = yield* openCodeExecutable(launcherName)
		const {
			OPENCODE_CONFIG_CONTENT: _paseoConfig,
			OPENCODE_PASSWORD: _paseoPassword,
			...environment
		} = process.env
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const code = yield* spawner.exitCode(
			ChildProcess.make(executable, args, {
				env: environment,
				stdin: 'inherit',
				stdout: 'inherit',
				stderr: 'inherit',
				detached: false,
			}),
		)
		process.exitCode = code
	})

const serve = Command.make(
	'serve',
	{
		hostname: Flag.String('hostname').pipe(Flag.withDefault('127.0.0.1')),
		port: Flag.Int('port').pipe(Flag.withDefault(0)),
	},
	({ hostname, port }) =>
		serveBridge({
			...paseoClient,
			launcher: launcherName,
			hostname,
			port,
			// Paseo starts at login beside the managed service and waits 30 seconds
			// for this server to announce itself.
			serviceWait: '20 seconds',
			prepare: registerToolBridge(process.env).pipe(
				Effect.catchTags({
					RegistrationError: ({ message }) => new LauncherError({ message }),
					ToolBridgeError: ({ message }) =>
						new LauncherError({ message: `Unable to read Paseo’s tool list: ${message}` }),
				}),
			),
		}),
).pipe(
	Command.withDescription(
		'Serve Paseo’s OpenCode API from the managed OpenCode service. Configure opencode-paseo as Paseo’s OpenCode provider command.',
	),
)

const launcher = Command.make(launcherName).pipe(Command.withSubcommands([serve]))

const main = Effect.gen(function* () {
	const args = process.argv.slice(2)
	if (args[0] !== 'serve') return yield* passThrough(args)
	return yield* Command.runWith(launcher, { version: 'limitless' })(args)
})

// Importing the bundle (as the runtime checks do) must not start the launcher.
if (
	process.argv[1] !== undefined &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
	runLauncher(launcherName, main)
