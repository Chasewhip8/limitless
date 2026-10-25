import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Config, Console, type Duration, Effect, Layer, Redacted, Schedule, Schema } from 'effect'
import { HttpServer, HttpServerError } from 'effect/http'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { managedBackend, ServiceBackend } from './backend'
import type { BridgeRouter } from './requests'
import { BridgeConfigError, layer as bridgeLayer } from './server'

export class LauncherError extends Schema.TaggedError<LauncherError>()('LauncherError', {
	message: Schema.String,
}) {}

/** The pinned OpenCode executable that the Nix launcher wrapper names. */
export const openCodeExecutable = (launcher: string) =>
	Config.String('LIMITLESS_OPENCODE_BIN').pipe(
		Effect.mapError(() => new LauncherError({ message: `Use the packaged ${launcher} launcher` })),
	)

/**
 * Clients probe their OpenCode binary with `--version`; answer with the wrapped
 * OpenCode's exact output so the client's compatibility check sees the real version.
 */
export const printOpenCodeVersion = (launcher: string) =>
	Effect.gen(function* () {
		const executable = yield* openCodeExecutable(launcher)
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const version = yield* spawner.string(ChildProcess.make(executable, ['--version']))
		yield* Console.log(version.trim())
	})

export interface ServeOptions<E, R> {
	readonly launcher: string
	readonly client: string
	readonly route: BridgeRouter
	readonly hostname: string
	readonly port: number
	/**
	 * How long to wait for the managed service before failing. A client launched
	 * at boot can otherwise start before the service is listening.
	 */
	readonly serviceWait?: Duration.Input
	/** Runs once the managed service is reachable, before the server is announced. */
	readonly prepare?: Effect.Effect<void, E, R>
}

/**
 * Serves the client's OpenCode API from the managed service and announces it
 * on stdout, where the client looks for the server it launched.
 */
export const serveBridge = <E = never, R = never>(options: ServeOptions<E, R>) =>
	Effect.gen(function* () {
		const password = yield* Config.Redacted('OPENCODE_PASSWORD').pipe(
			Effect.mapError(
				() =>
					new LauncherError({
						message: `${options.client} must supply OPENCODE_PASSWORD when launching ${options.launcher}`,
					}),
			),
		)
		const bridge = bridgeLayer({
			client: options.client,
			password: Redacted.value(password),
			route: options.route,
			hostname: options.hostname,
			port: options.port,
		}).pipe(Layer.provideMerge(managedBackend))
		return yield* Effect.gen(function* () {
			// Fail visibly at launch rather than answering the client's first check with a 502.
			const backend = yield* ServiceBackend
			yield* backend.resolve.pipe(
				options.serviceWait === undefined
					? (resolve) => resolve
					: Effect.retry({
							// Only an absent service is worth waiting for; misconfiguration fails at once.
							while: (error) => error.unavailable === true,
							schedule: Schedule.spaced('250 millis').pipe(
								Schedule.upTo({ duration: options.serviceWait }),
							),
						}),
				Effect.mapError(({ message }) => new LauncherError({ message })),
			)
			if (options.prepare !== undefined) yield* options.prepare
			// Clients read this exact line to find the server they launched.
			yield* HttpServer.addressFormattedWith((url) =>
				Console.log(`opencode server listening on ${url}`),
			)
			return yield* Effect.never
		}).pipe(Effect.provide(bridge))
	})

/** The one-line explanation of an expected launch failure, or undefined for a defect. */
function launchFailure(error: unknown): string | undefined {
	if (Schema.is(LauncherError)(error) || Schema.is(BridgeConfigError)(error)) return error.message
	if (error instanceof HttpServerError.ServeError)
		return `could not listen: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`
	return undefined
}

/**
 * Runs a launcher's main effect. Expected launch failures are one line on
 * stderr for the client's provider status. Stopping only detaches the client;
 * the managed service and its sessions keep running.
 */
export function runLauncher<E>(
	launcher: string,
	main: Effect.Effect<void, E, NodeServices.NodeServices>,
) {
	main.pipe(
		Effect.catch((error) => {
			const message = launchFailure(error)
			if (message === undefined) return Effect.fail(error)
			return Console.error(`${launcher}: ${message}`).pipe(
				Effect.andThen(
					Effect.sync(() => {
						process.exitCode = 1
					}),
				),
			)
		}),
		Effect.provide(NodeServices.layer),
		NodeRuntime.runMain,
	)
}
