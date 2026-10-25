import { Effect, Schema } from 'effect'

/**
 * A client for the Paseo daemon's tool bridge (`/_internal/opencode`), which
 * serves Paseo's tools to the OpenCode servers Paseo launches. Paseo's own
 * OpenCode plugin speaks the same unversioned protocol; the paseo-protocol
 * check pins the upstream source it was written against.
 */

/** Where a Paseo daemon's tool bridge listens, and the token it requires. */
export interface ToolBridge {
	readonly baseUrl: string
	readonly token: string
}

export const PaseoTool = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	inputSchema: Schema.Record(Schema.String, Schema.Unknown),
	title: Schema.optional(Schema.String),
})
export type PaseoTool = typeof PaseoTool.Type

export class ToolBridgeError extends Schema.TaggedError<ToolBridgeError>()('ToolBridgeError', {
	message: Schema.String,
	/** The HTTP status the tool bridge answered with, when it answered at all. */
	status: Schema.optional(Schema.Number),
}) {}

/** Paseo's tool bridge serves loopback only; anything else must never receive its token. */
export function isLoopbackToolBridge(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl)
		return (
			url.protocol === 'http:' &&
			['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) &&
			url.username === '' &&
			url.password === ''
		)
	} catch {
		return false
	}
}

const prefix = '/_internal/opencode'

/** Lookups run before every step of a Paseo session, so a stalled daemon must not stall OpenCode. */
const lookupTimeout = 1500
/** Paseo's tools return once started; they do not wait for the work they start. */
const executionTimeout = 120_000

const request = (bridge: ToolBridge, pathname: string, timeout: number, body?: unknown) =>
	Effect.tryPromise({
		try: (interrupted) =>
			fetch(new URL(`${prefix}${pathname}`, bridge.baseUrl), {
				method: body === undefined ? 'GET' : 'POST',
				headers: {
					authorization: `Bearer ${bridge.token}`,
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.any([interrupted, AbortSignal.timeout(timeout)]),
			}),
		catch: () => new ToolBridgeError({ message: 'The Paseo daemon is unreachable' }),
	})

const readJson = (response: Response) =>
	Effect.tryPromise({
		try: () => response.json() as Promise<unknown>,
		catch: () =>
			new ToolBridgeError({
				message: 'The Paseo daemon returned an unreadable response',
				status: response.status,
			}),
	})

const Failure = Schema.Struct({
	error: Schema.optional(Schema.String),
	issues: Schema.optional(Schema.Unknown),
	details: Schema.optional(Schema.Unknown),
})

/** Paseo's error text, including schema issues, as its own plugin reports it. */
const failure = (response: Response) =>
	readJson(response).pipe(
		Effect.orElseSucceed(() => undefined),
		Effect.flatMap((payload) => {
			const decoded = Schema.decodeUnknownOption(Failure)(payload)
			const error = decoded._tag === 'Some' ? decoded.value : {}
			const detail = describeIssues(error.issues ?? error.details)
			const message = error.error || `Paseo tool bridge returned HTTP ${response.status}`
			return new ToolBridgeError({
				message: detail ? `${message}: ${detail}` : message,
				status: response.status,
			})
		}),
	)

function describeIssues(details: unknown): string {
	if (typeof details === 'string') return details
	if (!Array.isArray(details)) return ''
	return details
		.map((issue) => {
			const path =
				Array.isArray(issue?.path) && issue.path.length > 0 ? issue.path.join('.') : 'input'
			return `${path}: ${typeof issue?.message === 'string' ? issue.message : 'Invalid value'}`
		})
		.join('; ')
}

const decode =
	<S extends Schema.Top>(schema: S, what: string) =>
	(value: unknown) =>
		Schema.decodeUnknownEffect(schema)(value).pipe(
			Effect.mapError(
				() => new ToolBridgeError({ message: `The Paseo daemon returned an unexpected ${what}` }),
			),
		)

const Manifest = Schema.Struct({ tools: Schema.Array(PaseoTool) })

/** The tools Paseo offers to the agents it launches, before per-agent policy. */
export const fetchManifest = (bridge: ToolBridge) =>
	Effect.gen(function* () {
		const response = yield* request(bridge, '/tools', lookupTimeout)
		if (!response.ok) return yield* failure(response)
		const manifest = yield* readJson(response).pipe(Effect.flatMap(decode(Manifest, 'tool list')))
		return manifest.tools
	})

const Binding = Schema.Struct({ tools: Schema.Array(Schema.String) })

export type SessionBinding =
	| { readonly _tag: 'Bound'; readonly sessionID: string; readonly tools: ReadonlySet<string> }
	| { readonly _tag: 'Unbound' }

/**
 * Whether Paseo drives this exact session, and which of its tools that agent
 * may use. Paseo answers 404 for sessions it has not bound.
 */
export const sessionBinding = (bridge: ToolBridge, sessionID: string) =>
	Effect.gen(function* () {
		const response = yield* request(
			bridge,
			`/sessions/${encodeURIComponent(sessionID)}/context?tools`,
			lookupTimeout,
		)
		if (response.status === 404) return { _tag: 'Unbound' } as SessionBinding
		if (!response.ok) return yield* failure(response)
		const binding = yield* readJson(response).pipe(Effect.flatMap(decode(Binding, 'binding')))
		return { _tag: 'Bound', sessionID, tools: new Set(binding.tools) } as SessionBinding
	})

const ToolContent = Schema.Union([
	Schema.Struct({ type: Schema.Literal('text'), text: Schema.String }),
	Schema.Struct({ type: Schema.Literal('image'), data: Schema.String, mimeType: Schema.String }),
	Schema.Struct({ type: Schema.String }),
])

const ToolResponse = Schema.Struct({
	content: Schema.Array(ToolContent),
	isError: Schema.optional(Schema.Boolean),
})
export type ToolResponse = typeof ToolResponse.Type

/** Runs one Paseo tool as the agent bound to `sessionID`, with the model's raw arguments. */
export const executeTool = (bridge: ToolBridge, sessionID: string, name: string, input: unknown) =>
	Effect.gen(function* () {
		const response = yield* request(
			bridge,
			`/sessions/${encodeURIComponent(sessionID)}/tools/${encodeURIComponent(name)}`,
			executionTimeout,
			input ?? {},
		)
		if (!response.ok) return yield* failure(response)
		return yield* readJson(response).pipe(Effect.flatMap(decode(ToolResponse, 'tool result')))
	})
