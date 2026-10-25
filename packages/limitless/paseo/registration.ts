import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { Effect, Schema } from 'effect'
import { fetchManifest, isLoopbackToolBridge, PaseoTool, type ToolBridge } from './tool-bridge'

/**
 * How the short-lived `opencode-paseo` launcher tells the long-lived `paseo`
 * plugin where the Paseo daemon's tool bridge listens. Paseo hands the tool
 * bridge's address and token only to the OpenCode servers it launches, so the
 * launcher records them, with Paseo's tool list, for the plugin running in the
 * managed service.
 */

export const Registration = Schema.Struct({
	v: Schema.Literal(1),
	baseUrl: Schema.String,
	token: Schema.String,
	tools: Schema.Array(PaseoTool),
})
export type Registration = typeof Registration.Type

export class RegistrationError extends Schema.TaggedError<RegistrationError>()(
	'RegistrationError',
	{ message: Schema.String },
) {}

export const registrationPath = (environment: NodeJS.ProcessEnv = process.env) =>
	Effect.gen(function* () {
		const runtime = environment.XDG_RUNTIME_DIR
		if (runtime === undefined || !isAbsolute(runtime))
			return yield* new RegistrationError({
				message:
					'XDG_RUNTIME_DIR must name an absolute directory for the Paseo tool bridge registration',
			})
		return join(runtime, 'limitless', 'paseo-tool-bridge.json')
	})

const PluginEntry = Schema.Struct({
	package: Schema.String,
	options: Schema.Struct({ baseUrl: Schema.String, token: Schema.String }),
})
const LaunchConfig = Schema.Struct({ plugins: Schema.Array(Schema.Unknown) })

/**
 * Finds Paseo's plugin entry in the OpenCode configuration Paseo passes to the
 * server it launches: a package under Paseo's runtime directory whose options
 * carry the tool bridge's address and token.
 */
export const toolBridgeFromLaunchConfig = (content: string | undefined) =>
	Effect.gen(function* () {
		const missing = new RegistrationError({
			message: 'Paseo did not pass its tool bridge in OPENCODE_CONFIG_CONTENT',
		})
		if (content === undefined) return yield* missing
		const config = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LaunchConfig))(
			content,
		).pipe(Effect.mapError(() => missing))
		const entries = config.plugins.flatMap((entry) => {
			const decoded = Schema.decodeUnknownOption(PluginEntry)(entry)
			return decoded._tag === 'Some' && /\/paseo-v2-[^/]+\/?$/.test(decoded.value.package)
				? [decoded.value.options]
				: []
		})
		const [bridge, ...others] = entries
		if (bridge === undefined) return yield* missing
		if (others.length > 0)
			return yield* new RegistrationError({
				message: 'Paseo passed more than one tool bridge in OPENCODE_CONFIG_CONTENT',
			})
		if (!isLoopbackToolBridge(bridge.baseUrl) || bridge.token.length === 0)
			return yield* new RegistrationError({
				message: 'Paseo’s tool bridge must be a loopback HTTP address with a token',
			})
		return bridge satisfies ToolBridge
	})

/** Identifies one version of the registration file, so readers notice replacement. */
export type RegistrationStamp = string

export interface RegistrationSnapshot {
	readonly stamp: RegistrationStamp | undefined
	readonly registration: Registration | undefined
}

const decodeRegistration = Schema.decodeUnknownEffect(Schema.fromJsonString(Registration))

const stampOf = (status: Stats): RegistrationStamp =>
	`${status.ino}:${status.mtimeMs}:${status.size}`

/** The file's status, or undefined when it does not exist. */
const statIfPresent = (path: string) =>
	Effect.tryPromise({
		try: () =>
			stat(path).catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') return undefined
				throw error
			}),
		catch: () =>
			new RegistrationError({ message: `Unable to inspect the Paseo registration ${path}` }),
	})

/**
 * Reads the current registration. A missing file is an absent registration; an
 * unreadable or invalid one is reported, so a stale or foreign file never
 * becomes a source of tools.
 */
export const readRegistration = (path: string) =>
	Effect.gen(function* () {
		const status = yield* statIfPresent(path)
		if (status === undefined) return { stamp: undefined, registration: undefined }
		const text = yield* Effect.tryPromise({
			try: () => readFile(path, 'utf8'),
			catch: () =>
				new RegistrationError({ message: `Unable to read the Paseo registration ${path}` }),
		})
		const registration = yield* decodeRegistration(text).pipe(
			Effect.mapError(
				() => new RegistrationError({ message: `Invalid Paseo registration ${path}` }),
			),
		)
		if (!isLoopbackToolBridge(registration.baseUrl))
			return yield* new RegistrationError({
				message: `The Paseo registration ${path} names a non-loopback tool bridge`,
			})
		return { stamp: stampOf(status), registration } satisfies RegistrationSnapshot
	})

/** Only the stamp, for cheap change detection. */
export const registrationStamp = (path: string) =>
	statIfPresent(path).pipe(
		Effect.map((status) => (status === undefined ? undefined : stampOf(status))),
		Effect.orElseSucceed(() => undefined),
	)

/** Replaces the registration atomically; only the owning user can read it. */
const writeRegistration = (path: string, registration: Registration) =>
	Effect.tryPromise({
		try: async () => {
			const directory = dirname(path)
			await mkdir(directory, { recursive: true, mode: 0o700 })
			await chmod(directory, 0o700)
			const temporary = join(directory, `.paseo-tool-bridge.${randomUUID()}.tmp`)
			try {
				await writeFile(temporary, `${JSON.stringify(registration)}\n`, { mode: 0o600, flag: 'wx' })
				await rename(temporary, path)
			} catch (error) {
				await unlink(temporary).catch(() => undefined)
				throw error
			}
		},
		catch: () =>
			new RegistrationError({ message: `Unable to write the Paseo registration ${path}` }),
	})

const sameRegistration = (left: Registration, right: Registration) =>
	JSON.stringify(left) === JSON.stringify(right)

/**
 * Records the tool bridge of the Paseo daemon launching this server. Every
 * server one daemon launches carries the same bridge, so an unchanged
 * registration is left alone and the plugin keeps its tools. A registration
 * for a different bridge that still answers belongs to another Paseo daemon;
 * both would keep replacing it, so this launch fails instead. Launches that
 * race from two daemons at the same moment can both pass this check, and the
 * later write wins; the check exists to surface that misconfiguration.
 */
export const registerToolBridge = (environment: NodeJS.ProcessEnv) =>
	Effect.gen(function* () {
		const bridge = yield* toolBridgeFromLaunchConfig(environment.OPENCODE_CONFIG_CONTENT)
		const tools = yield* fetchManifest(bridge)
		const path = yield* registrationPath(environment)
		const registration: Registration = { v: 1, ...bridge, tools }
		const previous = (yield* readRegistration(path).pipe(
			Effect.orElseSucceed(() => ({ registration: undefined })),
		)).registration
		if (previous !== undefined && sameRegistration(previous, registration)) return
		if (
			previous !== undefined &&
			(previous.baseUrl !== bridge.baseUrl || previous.token !== bridge.token)
		) {
			const live = yield* fetchManifest(previous).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false),
			)
			if (live)
				return yield* new RegistrationError({
					message: `Another Paseo daemon is registered in ${path}; stop it before using this one`,
				})
		}
		yield* writeRegistration(path, registration)
	})
