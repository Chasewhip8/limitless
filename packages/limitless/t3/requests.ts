import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import { Permission } from '@opencode/schema/permission'
import { Schema } from 'effect'
import { T3_CONTEXT } from './instructions'
import { canonicalT3Namespace, normalizeT3Permissions, T3PermissionError } from './permissions'

export interface Backend {
	readonly url: URL
	readonly headers: Readonly<Record<string, string>>
}

export interface BridgeReply {
	readonly status: number
	readonly body: Uint8Array
	readonly headers: Record<string, string>
}

export type BridgeRoute =
	| { readonly kind: 'reply'; readonly reply: BridgeReply }
	| { readonly kind: 'forward'; readonly body?: Buffer; readonly pathname?: string }

export class BridgeRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message)
	}
}

const decodeObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))
const decodePermissions = Schema.decodeUnknownSync(Permission.Ruleset)
const decodeSession = Schema.decodeUnknownSync(
	Schema.Struct({
		data: Schema.Struct({
			id: Schema.String,
			location: Schema.Struct({ directory: Schema.String }),
			agent: Schema.optional(Schema.String),
		}),
	}),
)
const decodeRpcResult = Schema.decodeUnknownSync(Schema.Struct({ output: Schema.Null }))
const decodeAgents = Schema.decodeUnknownSync(
	Schema.Struct({
		data: Schema.Array(
			Schema.Struct({
				id: Schema.String,
				mode: Schema.String,
				hidden: Schema.Boolean,
			}),
		),
	}),
)
const maximumControlBody = 1024 * 1024

async function readObject(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		size += bytes.length
		if (size > maximumControlBody)
			throw new BridgeRequestError(413, 'T3 control request is too large')
		chunks.push(bytes)
	}
	try {
		return decodeObject(JSON.parse(Buffer.concat(chunks).toString('utf8')))
	} catch {
		throw new BridgeRequestError(400, 'T3 control request must contain a JSON object')
	}
}

async function replyFrom(response: Response): Promise<BridgeReply> {
	const body = new Uint8Array(await response.arrayBuffer())
	const headers = Object.fromEntries(response.headers)
	// fetch decodes compressed responses; the forwarded bytes need fresh framing.
	for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'connection'])
		delete headers[name]
	return { status: response.status, body, headers }
}

export async function coordinateSession(
	backend: Backend,
	sessionID: string,
	permissions: Permission.Ruleset | undefined,
	signal: AbortSignal,
): Promise<BridgeReply | undefined> {
	const found = await fetch(new URL(`/api/session/${encodeURIComponent(sessionID)}`, backend.url), {
		headers: backend.headers,
		signal,
	})
	if (!found.ok) return replyFrom(found)
	const session = decodeSession(await found.json()).data
	// Preparation must read permissions inside the backend queue, not turn this
	// location lookup into a stale full-array replacement.
	const method = permissions === undefined ? 'prepareSession' : 'updatePermissions'
	const response = await fetch(new URL(`/api/rpc/limitless.t3/${method}`, backend.url), {
		method: 'POST',
		headers: {
			...backend.headers,
			'content-type': 'application/json',
			'x-opencode-directory': encodeURIComponent(session.location.directory),
		},
		body: JSON.stringify({
			input: { sessionID, ...(permissions === undefined ? {} : { permissions }) },
		}),
		signal,
	})
	if (!response.ok) return replyFrom(response)
	decodeRpcResult(await response.json())
}

export async function routeT3Request(
	request: IncomingMessage,
	url: URL,
	backend: Backend,
	signal: AbortSignal,
): Promise<BridgeRoute> {
	const mcpPath = /^(\/api\/experimental\/mcp\/)(t3-code-[^/]+)(.*)$/.exec(url.pathname)
	if (mcpPath?.[2] !== undefined) {
		const namespace = decodeURIComponent(mcpPath[2])
		if (!/^t3-code-[A-Za-z0-9_-]{1,56}$/.test(namespace))
			throw new BridgeRequestError(400, 'Invalid T3 MCP namespace')
		return {
			kind: 'forward',
			pathname: `${mcpPath[1]}${canonicalT3Namespace(namespace)}${mcpPath[3] ?? ''}`,
		}
	}
	if (request.method === 'POST' && url.pathname === '/api/session') {
		const body = await readObject(request)
		const agent = body.agent
		if (agent !== undefined && typeof agent !== 'string')
			throw new BridgeRequestError(400, 'Invalid OpenCode agent')
		let permissions: Permission.Ruleset
		try {
			permissions = decodePermissions(body.permissions ?? [])
		} catch {
			throw new BridgeRequestError(400, 'Invalid OpenCode permissions')
		}
		let normalized: Permission.Ruleset
		try {
			normalized = normalizeT3Permissions(permissions, agent)
		} catch (error) {
			if (Schema.is(T3PermissionError)(error)) throw new BridgeRequestError(400, error.message)
			throw error
		}
		return {
			kind: 'forward',
			body: Buffer.from(
				JSON.stringify({
					...body,
					permissions: normalized,
				}),
			),
		}
	}

	const sessionPath = /^\/api\/(?:experimental\/)?session\/([^/]+)(.*)$/.exec(url.pathname)
	if (!sessionPath) return { kind: 'forward' }
	const encodedID = sessionPath[1]
	if (encodedID === undefined) return { kind: 'forward' }
	const sessionID = decodeURIComponent(encodedID)
	const suffix = sessionPath[2] ?? ''

	if (request.method === 'POST' && suffix === '/agent') {
		const body = await readObject(request)
		if (body.agent === 'build') {
			// T3 uses "build" to mean normal mode; Limitless may be the actual default.
			const found = await fetch(
				new URL(`/api/session/${encodeURIComponent(sessionID)}`, backend.url),
				{ headers: backend.headers, signal },
			)
			if (!found.ok) return { kind: 'reply', reply: await replyFrom(found) }
			const session = decodeSession(await found.json()).data
			const agents = await fetch(new URL('/api/agent', backend.url), {
				headers: {
					...backend.headers,
					'x-opencode-directory': encodeURIComponent(session.location.directory),
				},
				signal,
			})
			if (!agents.ok) return { kind: 'reply', reply: await replyFrom(agents) }
			const selected = decodeAgents(await agents.json()).data[0]
			if (!selected || selected.hidden || selected.mode === 'subagent')
				throw new BridgeRequestError(502, 'Unable to resolve the default OpenCode agent')
			if (session.agent === undefined || session.agent === selected.id) {
				return { kind: 'reply', reply: { status: 204, body: new Uint8Array(), headers: {} } }
			}
			body.agent = selected.id
		}
		return { kind: 'forward', body: Buffer.from(JSON.stringify(body)) }
	}

	if (request.method === 'PATCH' && suffix === '') {
		const body = await readObject(request)
		if (!Object.hasOwn(body, 'permissions'))
			return { kind: 'forward', body: Buffer.from(JSON.stringify(body)) }
		if (Object.keys(body).length !== 1)
			throw new BridgeRequestError(
				400,
				'T3 permission updates must be separate from other session updates',
			)
		let permissions: Permission.Ruleset
		try {
			permissions = decodePermissions(body.permissions)
		} catch {
			throw new BridgeRequestError(400, 'Invalid OpenCode permissions')
		}
		const failure = await coordinateSession(backend, sessionID, permissions, signal)
		if (failure) return { kind: 'reply', reply: failure }
		return { kind: 'reply', reply: { status: 204, body: new Uint8Array(), headers: {} } }
	}

	if (request.method === 'PUT' && suffix === '/instructions/entries/t3-code') {
		const body = await readObject(request)
		if (!Object.hasOwn(body, 'value'))
			throw new BridgeRequestError(400, 'T3 instruction entry is missing its value')
		const failure = await coordinateSession(backend, sessionID, undefined, signal)
		if (failure) return { kind: 'reply', reply: failure }
		return { kind: 'forward', body: Buffer.from(JSON.stringify({ ...body, value: T3_CONTEXT })) }
	}

	if (
		request.method === 'POST' &&
		['/prompt', '/command', '/compact', '/generate', '/synthetic'].includes(suffix)
	) {
		const failure = await coordinateSession(backend, sessionID, undefined, signal)
		if (failure) return { kind: 'reply', reply: failure }
	}
	return { kind: 'forward' }
}

export function forwardingHeaders(incoming: IncomingHttpHeaders, backend: Backend) {
	const headers: IncomingHttpHeaders = { ...incoming, host: backend.url.host }
	delete headers.authorization
	delete headers['proxy-authorization']
	for (const [name, value] of Object.entries(backend.headers)) headers[name.toLowerCase()] = value
	return headers
}
