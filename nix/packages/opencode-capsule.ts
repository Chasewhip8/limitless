// Copied by opencode.nix to packages/server/src/limitless-capsule.ts, beside Capsule's source in
// ./limitless-capsule/, so Capsule shares this server's Effect and Core instances.
import { NodeServices } from '@effect/platform-node'
import { SdkPlugins } from '@opencode/core/plugin/sdk'
import { Session } from '@opencode/core/session'
import { Workspace } from '@opencode/core/workspace'
import { WorkspaceDriver } from '@opencode/core/workspace/driver'
import { Agent } from '@opencode/schema/agent'
import { Location } from '@opencode/schema/location'
import { Session as SessionSchema } from '@opencode/schema/session'
import { Context, Effect, FileSystem, Predicate, Schema } from 'effect'
import {
	makeDriver,
	makeHost,
	makePlugin,
	type NativePorts,
	type NativeSession,
	resolveSettings,
} from './limitless-capsule/host'
import { Capsule, make as makeCapsule } from './limitless-capsule/service'

type Services = Session.Service | Workspace.Service | SdkPlugins.Service

const nativeSession = (session: SessionSchema.Info): NativeSession => ({
	id: session.id,
	location: { directory: session.location.directory, workspaceID: session.location.workspaceID },
	agent: session.agent,
	metadata: session.metadata,
	parentID: session.parentID,
	fork: session.fork,
})

const nativePorts = (context: Context.Context<Services>): NativePorts => {
	const sessions = Context.get(context, Session.Service)
	const workspaces = Context.get(context, Workspace.Service)
	const workspaceId = Schema.decodeUnknownEffect(Workspace.ID)
	const sessionId = Schema.decodeUnknownEffect(SessionSchema.ID)
	return {
		workspaces: {
			create: Effect.fn('LimitlessCapsule.createWorkspace')(function* ({ id, provider }) {
				return yield* workspaces.create({ id: yield* workspaceId(id), provider })
			}),
			get: Effect.fn('LimitlessCapsule.getWorkspace')(function* (id) {
				return yield* workspaces
					.get(yield* workspaceId(id))
					.pipe(Effect.catchTag('Workspace.NotFound', () => Effect.succeed(undefined)))
			}),
			provision: Effect.fn('LimitlessCapsule.provisionWorkspace')(function* (id) {
				const { provider, binding } = yield* workspaces.provision(yield* workspaceId(id))
				return { id, provider, binding }
			}),
		},
		sessions: {
			get: Effect.fn('LimitlessCapsule.getSession')(function* (id) {
				const session = yield* sessions
					.get(yield* sessionId(id))
					.pipe(Effect.catchTag('Session.NotFoundError', () => Effect.succeed(undefined)))
				return session && nativeSession(session)
			}),
			create: Effect.fn('LimitlessCapsule.createSession')(function* (input) {
				const session = yield* sessions.create({
					id: yield* sessionId(input.id),
					location: yield* Schema.decodeUnknownEffect(Location.Ref)(input.location),
					agent: Agent.ID.make(input.agent),
					metadata: yield* Schema.decodeUnknownEffect(SessionSchema.Metadata)(input.metadata),
				})
				return nativeSession(session)
			}),
		},
	}
}

// Boot reports this message; Capsule's own messages name no credentials.
const bootFailure = (error: unknown) =>
	new Error(
		Predicate.hasProperty(error, 'message') && Predicate.isString(error.message)
			? `Capsule host failed to start: ${error.message}`
			: 'Capsule host failed to start.',
	)

/**
 * Builds the Capsule workspace provider from the settings file at `configPath` before the server's
 * application layer, and returns its registry replacement. `activate` must receive the context
 * built with that replacement, so the plugin drives the same registry and Core services.
 */
export const load = Effect.fn('LimitlessCapsule.load')(
	function* (configPath: string) {
		if (process.platform !== 'linux') {
			return yield* Effect.fail(new Error('Capsule hosting requires Linux.'))
		}
		const fs = yield* FileSystem.FileSystem
		const text = yield* fs.readFileString(configPath)
		const json = yield* Effect.try({
			try: () => JSON.parse(text),
			catch: () => new Error('The Capsule host settings are not JSON.'),
		})
		const settings = yield* resolveSettings(json)
		const capsule = yield* makeCapsule({
			root: settings.root,
			runtime: settings.runtime,
			checkoutRoot: settings.checkoutRoot,
			...(settings.credentials ? { credentials: settings.credentials } : {}),
		})
		const driver = yield* makeDriver((message) => WorkspaceDriver.Error.make({ message })).pipe(
			Effect.provideService(Capsule, capsule),
		)
		const services = yield* Effect.context<NodeServices.NodeServices>()

		const activate = Effect.fn('LimitlessCapsule.activate')(
			function* (context: Context.Context<Services>) {
				const host = yield* makeHost(settings, capsule, nativePorts(context))
				const plugins = Context.get(context, SdkPlugins.Service)
				yield* plugins.register(makePlugin(host, settings.controlDirectory))
			},
			Effect.provideContext(services),
			Effect.mapError(bootFailure),
		)

		return {
			overrides: [
				WorkspaceDriver.node.replace(
					WorkspaceDriver.registryNode({ capsule: WorkspaceDriver.make(driver) }),
				),
			],
			activate,
		}
	},
	Effect.mapError(bootFailure),
	Effect.provide(NodeServices.layer),
)
