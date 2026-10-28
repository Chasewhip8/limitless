import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { NodeHttpClient, NodeHttpServer, NodeStream } from '@effect/platform-node'
import { Effect, Layer, ManagedRuntime, Schema, Stream } from 'effect'
import {
	Headers,
	HttpBody,
	HttpClient,
	HttpClientRequest,
	type HttpClientResponse,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse,
} from 'effect/http'
import { type Backend, BridgeError, backendURL, ServiceBackend } from './backend'
import type { BridgeRouter } from './requests'

export interface BridgeOptions {
	readonly client: string
	/** The password the client generated for the server it believes it spawned. */
	readonly password: string
	readonly route: BridgeRouter
	readonly hostname?: string
	readonly port?: number
}

export class BridgeConfigError extends Schema.TaggedError<BridgeConfigError>()(
	'BridgeConfigError',
	{ message: Schema.String },
) {}

const loopback = ['127.0.0.1', '::1', 'localhost']

// Connection-scoped headers belong to each hop, as do any headers a
// `Connection` header nominates.
const hopByHopHeaders = [
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
]

function hopHeaders(headers: Headers.Headers): ReadonlyArray<string> {
	const nominated = (headers.connection ?? '')
		.split(',')
		.map((name) => name.trim().toLowerCase())
		.filter((name) => name.length > 0)
	return [...hopByHopHeaders, ...nominated]
}

function withoutHopHeaders(headers: Headers.Headers, others: ReadonlyArray<string> = []) {
	return Headers.removeMany(headers, [...hopHeaders(headers), ...others])
}

function authorizes(password: string) {
	const expected = Buffer.from(`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`)
	return (request: HttpServerRequest.HttpServerRequest) => {
		const supplied = Buffer.from(request.headers.authorization ?? '')
		return supplied.length === expected.length && timingSafeEqual(supplied, expected)
	}
}

/**
 * Clients send small JSON control requests, so bodies are read whole before
 * forwarding. A service that answers before reading the body (for example
 * with 413) then still reaches the client with its own response.
 */
const requestBody = (
	request: HttpServerRequest.HttpServerRequest,
	contentType: string | undefined,
	replacement?: Uint8Array,
) =>
	Effect.gen(function* () {
		if (replacement !== undefined) return HttpBody.uint8Array(replacement, contentType)
		const hasBody =
			request.headers['transfer-encoding'] !== undefined ||
			(request.headers['content-length'] ?? '0') !== '0'
		if (!hasBody) return HttpBody.empty
		const bytes = yield* request.arrayBuffer.pipe(
			Effect.mapError(() => new BridgeError({ status: 400, message: 'Unreadable request body' })),
		)
		return HttpBody.uint8Array(new Uint8Array(bytes), contentType)
	})

/**
 * Streams the service's response to the client unchanged. If the service's
 * stream fails, the client's connection is destroyed rather than ended, so a
 * cut-off event stream or chunked body never looks complete.
 */
function relay(response: HttpClientResponse.HttpClientResponse) {
	const body = response.stream.pipe(
		Stream.catchIf(
			(error) => error.reason._tag === 'EmptyBodyError',
			() => Stream.empty,
		),
	)
	// Cookies travel as separate Set-Cookie fields (one per name; OpenCode sets
	// none), since a folded header would merge them.
	const cookieHop = hopHeaders(response.headers).includes('set-cookie')
	return HttpServerResponse.raw(NodeStream.toReadableNever(body), {
		status: response.status,
		headers: withoutHopHeaders(response.headers, ['set-cookie']),
		...(cookieHop ? {} : { cookies: response.cookies }),
	})
}

const forward = Effect.fn('Bridge.forward')(function* (
	request: HttpServerRequest.HttpServerRequest,
	backend: Backend,
	target: URL,
	replacementBody?: Uint8Array,
) {
	// The client's credentials stop here; the managed service receives its own.
	const forwardedHeaders = withoutHopHeaders(Headers.fromInput(request.headers), [
		'authorization',
		'host',
		'content-length',
	])
	const contentType = forwardedHeaders['content-type']
	const body = yield* requestBody(request, contentType, replacementBody)
	let forwarded = HttpClientRequest.make(request.method)(target, {
		headers: Headers.merge(forwardedHeaders, Headers.fromInput(backend.headers)),
	}).pipe(HttpClientRequest.setBody(body))
	if (contentType === undefined)
		forwarded = HttpClientRequest.removeHeader(forwarded, 'content-type')
	const response = yield* HttpClient.execute(forwarded).pipe(
		Effect.mapError(
			() => new BridgeError({ status: 502, message: 'OpenCode service request failed' }),
		),
	)
	return relay(response)
})

const handle = (options: BridgeOptions) => {
	const authorized = authorizes(options.password)
	return Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		if (!authorized(request)) return HttpServerResponse.empty({ status: 401 })
		// OpenCode providers speak HTTP and server-sent events only.
		if (request.headers.upgrade !== undefined)
			return HttpServerResponse.text(`The ${options.client} bridge does not forward upgrades`, {
				status: 501,
			})
		const backend = yield* (yield* ServiceBackend).resolve
		const incoming = new URL(request.originalUrl, 'http://bridge.invalid')
		const route = yield* options.route(request, incoming.pathname, backend)
		switch (route._tag) {
			case 'Reply':
				return HttpServerResponse.empty({ status: route.status })
			case 'Relay':
				return relay(route.response)
			case 'Forward': {
				const target = backendURL(backend, route.pathname ?? incoming.pathname, incoming.search)
				return yield* forward(request, backend, target, route.body)
			}
		}
	}).pipe(
		Effect.catchTag('BridgeError', (error) =>
			Effect.succeed(HttpServerResponse.text(error.message, { status: error.status })),
		),
		// Forward the client's headers as sent, without adding trace context.
		Effect.provideService(HttpClient.TracerPropagationEnabled, false),
		// The HTTP server runs handlers uninterruptibly; a disconnected client must
		// still cancel a request that is waiting for the service.
		Effect.interruptible,
	)
}

/**
 * Closing the layer must only detach the client; sessions and the managed service
 * outlive the proxy.
 */
export const layer = (options: BridgeOptions) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const hostname = options.hostname ?? '127.0.0.1'
			if (!loopback.includes(hostname))
				return yield* new BridgeConfigError({
					message: `The ${options.client} bridge must listen on loopback`,
				})
			if (options.password.length === 0)
				return yield* new BridgeConfigError({
					message: `${options.client} must supply a bridge password`,
				})
			return HttpServer.serve(handle(options)).pipe(
				Layer.provideMerge(
					NodeHttpServer.layer(createServer, {
						host: hostname,
						port: options.port ?? 0,
						// Event streams never finish on their own; detach promptly.
						gracefulShutdownTimeout: '1 second',
					}),
				),
				Layer.provide(NodeHttpClient.layerNodeHttp),
			)
		}),
	)

export async function startBridge(
	options: BridgeOptions & { readonly backend: () => Promise<Backend> },
) {
	const backend = Layer.succeed(ServiceBackend, {
		resolve: Effect.tryPromise({
			try: options.backend,
			catch: () => new BridgeError({ status: 502, message: 'The OpenCode backend is unavailable' }),
		}),
	})
	const runtime = ManagedRuntime.make(layer(options).pipe(Layer.provide(backend)))
	try {
		const url = await runtime.runPromise(
			HttpServer.addressFormattedWith((address) => Effect.succeed(address)),
		)
		return { url, close: () => runtime.dispose() }
	} catch (error) {
		await runtime.dispose()
		throw error
	}
}
