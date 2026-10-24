import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Config, Console, Effect, Layer, Redacted, Schema } from 'effect'
import { Command, Flag } from 'effect/cli'
import { HttpServer } from 'effect/http'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { managedBackend, T3Backend } from './backend'
import { layer as bridgeLayer } from './bridge'

export { startT3Bridge } from './bridge'

class LauncherError extends Schema.TaggedError<LauncherError>()('LauncherError', {
	message: Schema.String,
}) {}

/**
 * T3 probes its OpenCode binary with `--version`; answer with the wrapped
 * OpenCode's exact output so T3's compatibility check sees the real version.
 */
const printOpenCodeVersion = Effect.gen(function* () {
	const executable = yield* Config.String('LIMITLESS_OPENCODE_BIN').pipe(
		Effect.mapError(() => new LauncherError({ message: 'Use the packaged opencode-t3 launcher' })),
	)
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const version = yield* spawner.string(ChildProcess.make(executable, ['--version']))
	yield* Console.log(version.trim())
})

const serve = Command.make(
	'serve',
	{
		hostname: Flag.String('hostname').pipe(Flag.withDefault('127.0.0.1')),
		port: Flag.Int('port').pipe(Flag.withDefault(0)),
	},
	Effect.fn('T3.serve')(function* ({ hostname, port }) {
		const password = yield* Config.Redacted('OPENCODE_PASSWORD').pipe(
			Effect.mapError(
				() =>
					new LauncherError({
						message: 'T3 must supply OPENCODE_PASSWORD when launching this adapter',
					}),
			),
		)
		const bridge = bridgeLayer({ password: Redacted.value(password), hostname, port }).pipe(
			Layer.provideMerge(managedBackend),
		)
		return yield* Effect.gen(function* () {
			// Fail visibly at launch rather than answering T3's first check with a 502.
			yield* (yield* T3Backend).resolve.pipe(
				Effect.mapError(({ message }) => new LauncherError({ message })),
			)
			// T3 reads this exact line to find the server it launched.
			yield* HttpServer.addressFormattedWith((url) =>
				Console.log(`opencode server listening on ${url}`),
			)
			return yield* Effect.never
		}).pipe(Effect.provide(bridge))
	}),
).pipe(
	Command.withDescription(
		'Serve T3’s OpenCode API from the managed OpenCode service. Set opencode-t3 as T3’s OpenCode Binary path and leave Server URL blank.',
	),
)

const launcher = Command.make('opencode-t3').pipe(Command.withSubcommands([serve]))

const main = Effect.gen(function* () {
	const args = process.argv.slice(2)
	if (args.length === 1 && (args[0] === '--version' || args[0] === '-v'))
		return yield* printOpenCodeVersion
	return yield* Command.runWith(launcher, { version: 'limitless' })(args)
})

// Importing the bundle (as the runtime checks do) must not start the launcher.
if (
	process.argv[1] !== undefined &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	// Expected launch failures are one line on stderr for T3's provider status.
	const exitWith = ({ message }: { readonly message: string }) =>
		Console.error(`opencode-t3: ${message}`).pipe(
			Effect.andThen(
				Effect.sync(() => {
					process.exitCode = 1
				}),
			),
		)
	// Stopping only detaches T3; the managed service and its sessions keep running.
	main.pipe(
		Effect.catchTags({
			LauncherError: exitWith,
			BridgeConfigError: exitWith,
			ServeError: ({ cause }) =>
				exitWith({
					message: `could not listen: ${cause instanceof Error ? cause.message : String(cause)}`,
				}),
		}),
		Effect.provide(NodeServices.layer),
		NodeRuntime.runMain,
	)
}
