import { Service } from '@opencode/client/effect/service'
import { Context, Effect, FileSystem, Layer, Schema } from 'effect'

export interface Backend {
	readonly url: URL
	readonly headers: Readonly<Record<string, string>>
}

export class BridgeError extends Schema.TaggedError<BridgeError>()('BridgeError', {
	status: Schema.Number,
	message: Schema.String,
}) {}

export class ServiceBackend extends Context.Service<
	ServiceBackend,
	{ readonly resolve: Effect.Effect<Backend, BridgeError> }
>()('@limitless/bridge/ServiceBackend') {}

/**
 * Only the path and query come from the client. The origin always comes from
 * the backend: a request target such as `//host/x` or `http://host/x` must never
 * send the managed service's credentials to a caller-selected origin.
 */
export function backendURL(backend: Backend, pathname: string, search = ''): URL {
	const target = new URL(backend.url)
	target.pathname = pathname
	target.search = search
	return target
}

/**
 * Resolves the system-managed OpenCode service on every request, so a service
 * restart with a new address or password needs no bridge restart. Discovery
 * never starts, replaces, or stops the service.
 */
export const managedBackend = Layer.effect(ServiceBackend)(
	Effect.gen(function* () {
		const fileSystem = yield* FileSystem.FileSystem
		const resolve = Effect.gen(function* () {
			const endpoint = yield* Service.discover()
			if (endpoint === undefined)
				return yield* new BridgeError({
					status: 502,
					message: 'The managed OpenCode service is unavailable; start it before connecting',
				})
			const headers = Service.headers({
				url: endpoint.url,
				...(endpoint.auth === undefined ? {} : { auth: endpoint.auth }),
			})
			if (headers === undefined)
				return yield* new BridgeError({
					status: 502,
					message: 'The managed OpenCode service must provide authentication',
				})
			return { url: new URL(endpoint.url), headers }
		}).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem))
		return { resolve }
	}),
)
