import { ByteSize, Data, Effect, Schema } from 'effect'
import {
	HttpClient,
	HttpClientRequest,
	type HttpClientResponse,
	HttpIncomingMessage,
	type HttpServerRequest,
} from 'effect/http'
import { type Backend, BridgeError, backendURL } from './backend'

/**
 * How one client request reaches the managed service. Most requests forward
 * unchanged; a forward may replace the path or the JSON body. A reply answers
 * the client without contacting the service, and a relay returns a response the
 * service already gave while the bridge resolved the request.
 */
export type BridgeRoute =
	| { readonly _tag: 'Forward'; readonly pathname?: string; readonly body?: Uint8Array }
	| { readonly _tag: 'Reply'; readonly status: number }
	| { readonly _tag: 'Relay'; readonly response: HttpClientResponse.HttpClientResponse }

/** Chooses how a bridge client's request reaches the managed service. */
export type BridgeRouter = (
	request: HttpServerRequest.HttpServerRequest,
	pathname: string,
	backend: Backend,
) => Effect.Effect<BridgeRoute, BridgeError, HttpClient.HttpClient>

export const reply = (status: number): BridgeRoute => ({ _tag: 'Reply', status })

export const forwardWith = (
	change: { readonly pathname?: string; readonly body?: unknown } = {},
): BridgeRoute => ({
	_tag: 'Forward',
	...(change.pathname === undefined ? {} : { pathname: change.pathname }),
	...(change.body === undefined
		? {}
		: { body: new TextEncoder().encode(JSON.stringify(change.body)) }),
})

const ControlBody = Schema.Record(Schema.String, Schema.Unknown)
const maximumControlBody = ByteSize.mebibytes(1)

/** Reads a small JSON control request the bridge rewrites before forwarding. */
export const readControlBody = (request: HttpServerRequest.HttpServerRequest, client: string) =>
	request.json.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(ControlBody)),
		Effect.provideService(HttpIncomingMessage.MaxBodySize, maximumControlBody),
		Effect.mapError(
			() =>
				new BridgeError({
					status: 400,
					message: `${client} control request must contain a JSON object of at most 1 MiB`,
				}),
		),
	)

export const decodePathSegment = (segment: string) =>
	Effect.try({
		try: () => decodeURIComponent(segment),
		catch: () => new BridgeError({ status: 400, message: 'Malformed request path' }),
	})

/** The service answered a lookup with an error that the client should see as sent. */
export class BackendRejected extends Data.TaggedError('BackendRejected')<{
	readonly response: HttpClientResponse.HttpClientResponse
}> {}

/** Relays a lookup the service rejected, so the client sees the service's own error. */
export const relayRejection = <A, R>(effect: Effect.Effect<A, BackendRejected | BridgeError, R>) =>
	effect.pipe(
		Effect.catchTag('BackendRejected', ({ response }) =>
			Effect.succeed<BridgeRoute>({ _tag: 'Relay', response }),
		),
	)

const backendJson = <S extends Schema.Top>(
	backend: Backend,
	pathname: string,
	schema: S,
	headers: Record<string, string> = {},
) =>
	Effect.gen(function* () {
		const response = yield* HttpClient.execute(
			HttpClientRequest.get(backendURL(backend, pathname), {
				headers: { ...backend.headers, ...headers },
			}),
		)
		if (response.status < 200 || response.status >= 300)
			return yield* new BackendRejected({ response })
		return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)))
	}).pipe(
		Effect.catchTags({
			HttpClientError: () =>
				new BridgeError({ status: 502, message: `OpenCode request ${pathname} failed` }),
			SchemaError: () =>
				new BridgeError({ status: 502, message: `OpenCode returned an unexpected ${pathname}` }),
		}),
	)

const SessionResponse = Schema.Struct({
	data: Schema.Struct({
		location: Schema.Struct({ directory: Schema.String }),
		agent: Schema.optional(Schema.String),
	}),
})

const AgentsResponse = Schema.Struct({
	data: Schema.Array(
		Schema.Struct({ id: Schema.String, mode: Schema.String, hidden: Schema.Boolean }),
	),
})

/**
 * Clients that assume OpenCode's built-in `build` agent select it by name;
 * Limitless disables it, so the bridge substitutes the Location's configured
 * default. OpenCode lists its resolved default agent first, including project
 * overrides.
 */
export const defaultAgentFor = Effect.fn('Bridge.defaultAgentFor')(function* (
	backend: Backend,
	directory: string,
) {
	const agents = yield* backendJson(backend, '/api/agent', AgentsResponse, {
		'x-opencode-directory': encodeURIComponent(directory),
	})
	const selected = agents.data[0]
	if (selected === undefined || selected.hidden || selected.mode === 'subagent')
		return yield* new BridgeError({
			status: 502,
			message: 'Unable to resolve the default OpenCode agent',
		})
	return selected.id
})

/** The session's current agent and its Location's configured default. */
export const sessionAgents = Effect.fn('Bridge.sessionAgents')(function* (
	backend: Backend,
	sessionID: string,
) {
	const session = yield* backendJson(
		backend,
		`/api/session/${encodeURIComponent(sessionID)}`,
		SessionResponse,
	)
	const configured = yield* defaultAgentFor(backend, session.data.location.directory)
	return { current: session.data.agent, configured }
})

const agentSelectionPath = /^\/api\/(?:experimental\/)?session\/([^/]+)\/agent$/

/**
 * Selecting the disabled `build` agent selects the Location's configured
 * default instead; selecting the agent a session already has is a no-op.
 */
export const routeBuildSelection = Effect.fn('Bridge.routeBuildSelection')(function* (
	request: HttpServerRequest.HttpServerRequest,
	pathname: string,
	backend: Backend,
	client: string,
) {
	const selection = request.method === 'POST' ? agentSelectionPath.exec(pathname) : null
	if (selection?.[1] === undefined) return undefined
	const body = yield* readControlBody(request, client)
	if (body.agent !== 'build') return forwardWith({ body })
	const sessionID = yield* decodePathSegment(selection[1])
	return yield* relayRejection(
		sessionAgents(backend, sessionID).pipe(
			Effect.map(({ current, configured }) =>
				current === undefined || current === configured
					? reply(204)
					: forwardWith({ body: { ...body, agent: configured } }),
			),
		),
	)
})
