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
import { type Backend, BridgeError, backendURL, T3Backend } from './backend'
import { routeT3Request } from './rewrites'

export interface T3BridgeOptions {
	/** The password T3 generated for the server it believes it spawned. */
	readonly password: string
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
 * T3 sends small JSON control requests, so bodies are read whole before
 * forwarding. A service that answers before reading the body (for example
 * with 413) then still reaches T3 with its own response.
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
 * Streams the service's response to T3 unchanged. If the service's stream
 * fails, T3's connection is destroyed rather than ended, so a cut-off event
 * stream or chunked body never looks complete.
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

const forward = Effect.fn('T3.forward')(function* (
	request: HttpServerRequest.HttpServerRequest,
	backend: Backend,
	target: URL,
	replacementBody?: Uint8Array,
) {
	// T3's credentials stop here; the managed service receives its own.
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
	// A body without a declared type is forwarded without one.
	if (contentType === undefined)
		forwarded = HttpClientRequest.removeHeader(forwarded, 'content-type')
	const response = yield* HttpClient.execute(forwarded).pipe(
		Effect.mapError(
			() => new BridgeError({ status: 502, message: 'OpenCode service request failed' }),
		),
	)
	return relay(response)
})

/** Answers one T3 request: authenticate, choose its route, then reply or forward. */
const handle = (password: string) => {
	const authorized = authorizes(password)
	return Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		if (!authorized(request)) return HttpServerResponse.empty({ status: 401 })
		// T3's OpenCode provider speaks HTTP and server-sent events only.
		if (request.headers.upgrade !== undefined)
			return HttpServerResponse.text('The T3 bridge does not forward upgrades', { status: 501 })
		const backend = yield* (yield* T3Backend).resolve
		const incoming = new URL(request.originalUrl, 'http://bridge.invalid')
		const route = yield* routeT3Request(request, incoming.pathname, backend)
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
		// Forward T3's headers as sent, without adding trace context.
		Effect.provideService(HttpClient.TracerPropagationEnabled, false),
		// The HTTP server runs handlers uninterruptibly; a disconnected client must
		// still cancel a request that is waiting for the service.
		Effect.interruptible,
	)
}

/**
 * Serves T3's OpenCode API on loopback by forwarding to the managed service.
 * Closing the layer only detaches T3: sessions and the service keep running.
 */
export const layer = (options: T3BridgeOptions) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const hostname = options.hostname ?? '127.0.0.1'
			if (!loopback.includes(hostname))
				return yield* new BridgeConfigError({ message: 'The T3 bridge must listen on loopback' })
			if (options.password.length === 0)
				return yield* new BridgeConfigError({ message: 'T3 must supply a bridge password' })
			return HttpServer.serve(handle(options.password)).pipe(
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

/** Promise-facing handle for JavaScript callers such as integration tests. */
export async function startT3Bridge(
	options: T3BridgeOptions & { readonly backend: () => Promise<Backend> },
) {
	const backend = Layer.succeed(T3Backend, {
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
