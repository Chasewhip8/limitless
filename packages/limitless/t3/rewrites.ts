import { ByteSize, Data, Effect, Schema } from 'effect'
import {
	HttpClient,
	HttpClientRequest,
	type HttpClientResponse,
	HttpIncomingMessage,
	type HttpServerRequest,
} from 'effect/http'
import { type Backend, BridgeError, backendURL } from './backend'
import { T3_CONTEXT } from './instructions'
import { canonicalT3Namespace } from './permissions'

/**
 * How one T3 request reaches the managed service. Most requests forward
 * unchanged; a forward may replace the path or the JSON body. A reply answers
 * T3 without contacting the service, and a relay returns a response the
 * service already gave while the bridge resolved the request.
 */
export type T3Route =
	| { readonly _tag: 'Forward'; readonly pathname?: string; readonly body?: Uint8Array }
	| { readonly _tag: 'Reply'; readonly status: number }
	| { readonly _tag: 'Relay'; readonly response: HttpClientResponse.HttpClientResponse }

const reply = (status: number): T3Route => ({ _tag: 'Reply', status })

const forwardWith = (
	change: { readonly pathname?: string; readonly body?: unknown } = {},
): T3Route => ({
	_tag: 'Forward',
	...(change.pathname === undefined ? {} : { pathname: change.pathname }),
	...(change.body === undefined
		? {}
		: { body: new TextEncoder().encode(JSON.stringify(change.body)) }),
})

const mcpServerPath = /^(\/api\/experimental\/mcp\/)(t3-code-[^/]+)(.*)$/
const t3InstructionsPath =
	/^\/api\/(?:experimental\/)?session\/[^/]+\/instructions\/entries\/t3-code$/
const agentSelectionPath = /^\/api\/(?:experimental\/)?session\/([^/]+)\/agent$/
const t3Namespace = /^t3-code-[A-Za-z0-9_-]{1,56}$/

const ControlBody = Schema.Record(Schema.String, Schema.Unknown)
const maximumControlBody = ByteSize.mebibytes(1)

const readControlBody = (request: HttpServerRequest.HttpServerRequest) =>
	request.json.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(ControlBody)),
		Effect.provideService(HttpIncomingMessage.MaxBodySize, maximumControlBody),
		Effect.mapError(
			() =>
				new BridgeError({
					status: 400,
					message: 'T3 control request must contain a JSON object of at most 1 MiB',
				}),
		),
	)

const decodePathSegment = (segment: string) =>
	Effect.try({
		try: () => decodeURIComponent(segment),
		catch: () => new BridgeError({ status: 400, message: 'Malformed request path' }),
	})

/** The service answered a lookup with an error that T3 should see as sent. */
class BackendRejected extends Data.TaggedError('BackendRejected')<{
	readonly response: HttpClientResponse.HttpClientResponse
}> {}

/**
 * Decides how a T3 request reaches the managed service:
 *
 * - T3's orchestration instructions become a marker that the Limitless plugin
 *   expands into its own guidance, so T3's text is never stored.
 * - T3 MCP server names are hashed when a thread ID contains underscores, so one
 *   thread's `<name>_*` grant cannot match a sibling such as `<name>_fork`.
 * - T3's normal-mode agent `build` (disabled in Limitless) selects the
 *   Location's configured default agent instead.
 */
export const routeT3Request = Effect.fn('T3.routeRequest')(function* (
	request: HttpServerRequest.HttpServerRequest,
	pathname: string,
	backend: Backend,
) {
	const mcpServer = mcpServerPath.exec(pathname)
	if (mcpServer !== null) {
		const [, prefix = '', encodedName = '', suffix = ''] = mcpServer
		const name = yield* decodePathSegment(encodedName)
		if (!t3Namespace.test(name))
			return yield* new BridgeError({ status: 400, message: 'Invalid T3 MCP namespace' })
		return forwardWith({ pathname: `${prefix}${canonicalT3Namespace(name)}${suffix}` })
	}

	if (request.method === 'PUT' && t3InstructionsPath.test(pathname)) {
		const body = yield* readControlBody(request)
		if (!Object.hasOwn(body, 'value'))
			return yield* new BridgeError({
				status: 400,
				message: 'T3 instruction entry is missing its value',
			})
		return forwardWith({ body: { ...body, value: T3_CONTEXT } })
	}

	const agentSelection = request.method === 'POST' ? agentSelectionPath.exec(pathname) : null
	if (agentSelection?.[1] !== undefined) {
		const body = yield* readControlBody(request)
		if (body.agent !== 'build') return forwardWith({ body })
		const sessionID = yield* decodePathSegment(agentSelection[1])
		return yield* resolveDefaultAgent(backend, sessionID).pipe(
			Effect.map(({ current, configured }) =>
				current === undefined || current === configured
					? reply(204)
					: forwardWith({ body: { ...body, agent: configured } }),
			),
			Effect.catchTag('BackendRejected', ({ response }) =>
				Effect.succeed<T3Route>({ _tag: 'Relay', response }),
			),
		)
	}

	return forwardWith()
})

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

// OpenCode lists its resolved default agent first, including project overrides.
const resolveDefaultAgent = Effect.fn('T3.resolveDefaultAgent')(function* (
	backend: Backend,
	sessionID: string,
) {
	const session = yield* backendJson(
		backend,
		`/api/session/${encodeURIComponent(sessionID)}`,
		SessionResponse,
	)
	const agents = yield* backendJson(backend, '/api/agent', AgentsResponse, {
		'x-opencode-directory': encodeURIComponent(session.data.location.directory),
	})
	const selected = agents.data[0]
	if (selected === undefined || selected.hidden || selected.mode === 'subagent')
		return yield* new BridgeError({
			status: 502,
			message: 'Unable to resolve the default OpenCode agent',
		})
	return { current: session.data.agent, configured: selected.id }
})
