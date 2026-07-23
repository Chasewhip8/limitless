/**
 * Derived from @ex-machina/opencode-anthropic-auth 1.8.1 (MIT).
 * Copyright (c) 2026 Ex Machina. See LICENSE.ex-machina.
 */
import { createHash } from 'node:crypto'
import { Effect, Option, Schema } from 'effect'

export const REQUIRED_ANTHROPIC_OAUTH_BETAS = [
	'oauth-2025-04-20',
	'interleaved-thinking-2025-05-14',
]
export const CLAUDE_CODE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
export const CLAUDE_CODE_VERSION = '2.1.87'
export const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`

const claudeCodeEntrypoint = 'sdk-cli'
const cchSalt = '59cf53e54c78'
const cchPositions = [4, 7, 20]
const toolPrefix = 'mcp_'
const paragraphRemovalAnchors = ['github.com/anomalyco/opencode', 'opencode.ai/docs']
const textReplacements = [
	{ match: 'if OpenCode honestly', replacement: 'if the assistant honestly' },
	{
		match: 'Here is some useful information about the environment you are running in:',
		replacement: 'Environment context you are running in:',
	},
]
const JsonRecord = Schema.Record(Schema.String, Schema.Json)

export class AnthropicRequestError extends Schema.TaggedErrorClass<AnthropicRequestError>()(
	'AnthropicRequestError',
	{ message: Schema.String, cause: Schema.Defect() },
) {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function prefixedToolName(name: string): string {
	return `${toolPrefix}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

function unprefixedToolName(name: string): string {
	if (name === 'StructuredOutput') return name
	return `${name.charAt(0).toLowerCase()}${name.slice(1)}`
}

export function mergeAnthropicHeaders(
	input: Parameters<typeof fetch>[0],
	init?: RequestInit,
): Headers {
	const headers = input instanceof Request ? new Headers(input.headers) : new Headers()
	const incoming = init?.headers
	if (incoming instanceof Headers) {
		incoming.forEach((value, key) => {
			headers.set(key, value)
		})
	} else if (Array.isArray(incoming)) {
		for (const [key, value] of incoming) {
			if (value !== undefined) headers.set(key, String(value))
		}
	} else if (incoming !== undefined) {
		for (const [key, value] of Object.entries(incoming)) {
			if (value !== undefined) headers.set(key, String(value))
		}
	}
	return headers
}

export function setAnthropicOAuthHeaders(headers: Headers, accessToken: string): Headers {
	const incoming = (headers.get('anthropic-beta') ?? '')
		.split(',')
		.map((value) => value.trim())
		.filter(Boolean)
	headers.set(
		'anthropic-beta',
		[...new Set([...REQUIRED_ANTHROPIC_OAUTH_BETAS, ...incoming])].join(','),
	)
	headers.set('authorization', `Bearer ${accessToken}`)
	headers.set('user-agent', CLAUDE_CODE_USER_AGENT)
	headers.delete('x-api-key')
	return headers
}

function validBaseUrl(raw: string | undefined): URL | undefined {
	if (!raw?.trim()) return undefined
	const parsed = (() => {
		try {
			return new URL(raw)
		} catch {
			return undefined
		}
	})()
	if (
		parsed === undefined ||
		!['http:', 'https:'].includes(parsed.protocol) ||
		parsed.username ||
		parsed.password
	) {
		return undefined
	}
	return parsed
}

export function rewriteAnthropicUrl(input: Parameters<typeof fetch>[0], baseUrlRaw?: string) {
	const requestUrl = (() => {
		try {
			return new URL(input instanceof Request ? input.url : input.toString())
		} catch {
			return undefined
		}
	})()
	if (requestUrl === undefined) return input
	const original = requestUrl.href
	const baseUrl = validBaseUrl(baseUrlRaw)
	if (baseUrl !== undefined) {
		requestUrl.protocol = baseUrl.protocol
		requestUrl.host = baseUrl.host
	}
	if (requestUrl.pathname === '/v1/messages' && !requestUrl.searchParams.has('beta')) {
		requestUrl.searchParams.set('beta', 'true')
	}
	if (requestUrl.href === original) return input
	return input instanceof Request ? new Request(requestUrl, input) : requestUrl
}

export function sanitizeAnthropicSystemText(text: string): string {
	const paragraphs = text.split(/\n\n+/u).filter((paragraph) => {
		if (paragraph.includes('You are OpenCode')) return false
		return !paragraphRemovalAnchors.some((anchor) => paragraph.includes(anchor))
	})
	let sanitized = paragraphs.join('\n\n')
	for (const replacement of textReplacements) {
		sanitized = sanitized.replace(replacement.match, replacement.replacement)
	}
	return sanitized.trim()
}

function systemBlock(text: string, properties: Record<string, unknown> = {}) {
	return { ...properties, type: 'text', text }
}

export function prependClaudeCodeIdentity(system: unknown) {
	const identity = systemBlock(CLAUDE_CODE_IDENTITY)
	if (system === undefined || system === null) return [identity]
	if (typeof system === 'string') {
		const sanitized = sanitizeAnthropicSystemText(system)
		return sanitized === CLAUDE_CODE_IDENTITY ? [identity] : [identity, systemBlock(sanitized)]
	}
	if (isRecord(system)) {
		return [
			identity,
			systemBlock(
				sanitizeAnthropicSystemText(typeof system.text === 'string' ? system.text : ''),
				system,
			),
		]
	}
	if (!Array.isArray(system)) return [identity]
	const sanitized = system.map((item) => {
		if (typeof item === 'string') return systemBlock(sanitizeAnthropicSystemText(item))
		if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
			return systemBlock(sanitizeAnthropicSystemText(item.text), item)
		}
		return systemBlock(String(item))
	})
	return sanitized[0]?.text === CLAUDE_CODE_IDENTITY ? sanitized : [identity, ...sanitized]
}

function firstUserMessageText(messages: ReadonlyArray<unknown>): string {
	const message = messages.find((item) => isRecord(item) && item.role === 'user')
	if (!isRecord(message)) return ''
	if (typeof message.content === 'string') return message.content
	if (!Array.isArray(message.content)) return ''
	const text = message.content.find(
		(item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string',
	)
	return isRecord(text) && typeof text.text === 'string' ? text.text : ''
}

function billingHeader(messages: ReadonlyArray<unknown>): string {
	const text = firstUserMessageText(messages)
	const cch = createHash('sha256').update(text).digest('hex').slice(0, 5)
	const sampled = cchPositions.map((position) => text[position] ?? '0').join('')
	const suffix = createHash('sha256')
		.update(`${cchSalt}${sampled}${CLAUDE_CODE_VERSION}`)
		.digest('hex')
		.slice(0, 3)
	return `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${suffix}; cc_entrypoint=${claudeCodeEntrypoint}; cch=${cch};`
}

function prefixRequestToolNames(body: Record<string, unknown>): Record<string, unknown> {
	const tools = Array.isArray(body.tools)
		? body.tools.map((tool) =>
				isRecord(tool) && typeof tool.name === 'string'
					? { ...tool, name: prefixedToolName(tool.name) }
					: tool,
			)
		: body.tools
	const messages = Array.isArray(body.messages)
		? body.messages.map((message) => {
				if (!isRecord(message) || !Array.isArray(message.content)) return message
				return {
					...message,
					content: message.content.map((block) =>
						isRecord(block) && block.type === 'tool_use' && typeof block.name === 'string'
							? { ...block, name: prefixedToolName(block.name) }
							: block,
					),
				}
			})
		: body.messages
	return { ...body, tools, messages }
}

export function rewriteAnthropicRequestBody(body: string): string {
	const decoded = Option.getOrUndefined(
		Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(body),
	)
	if (!Schema.is(JsonRecord)(decoded)) return body
	const messages = Array.isArray(decoded.messages) ? decoded.messages : []
	const system = prependClaudeCodeIdentity(decoded.system)
	const withBilling = messages.some((message) => isRecord(message) && message.role === 'user')
		? [systemBlock(billingHeader(messages)), ...system]
		: system
	return JSON.stringify(prefixRequestToolNames({ ...decoded, system: withBilling }))
}

export function stripAnthropicToolPrefixes(text: string): string {
	return text.replace(
		/"name"\s*:\s*"mcp_([^"]+)"/gu,
		(_match, name: string) => `"name": "${unprefixedToolName(name)}"`,
	)
}

export function transformAnthropicResponse(response: Response): Response {
	if (response.body === null) return response
	const decoder = new TextDecoder()
	const encoder = new TextEncoder()
	let buffered = ''
	const stream = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffered += decoder.decode(chunk, { stream: true })
				let newline = buffered.indexOf('\n')
				while (newline >= 0) {
					controller.enqueue(
						encoder.encode(stripAnthropicToolPrefixes(buffered.slice(0, newline + 1))),
					)
					buffered = buffered.slice(newline + 1)
					newline = buffered.indexOf('\n')
				}
			},
			flush(controller) {
				buffered += decoder.decode()
				if (buffered) controller.enqueue(encoder.encode(stripAnthropicToolPrefixes(buffered)))
			},
		}),
	)
	return new Response(stream, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
}

export const executeAnthropicOAuthRequest = Effect.fn('executeAnthropicOAuthRequest')(function* (
	accessToken: string,
	upstreamFetch: typeof fetch,
	input: Parameters<typeof fetch>[0],
	init?: RequestInit,
) {
	const headers = setAnthropicOAuthHeaders(mergeAnthropicHeaders(input, init), accessToken)
	const { body: originalBody, ...initWithoutBody } = init ?? {}
	const body =
		typeof originalBody === 'string' ? rewriteAnthropicRequestBody(originalBody) : originalBody
	const requestInit = {
		...initWithoutBody,
		...(body === undefined ? {} : { body }),
		headers,
		...(validBaseUrl(process.env.ANTHROPIC_BASE_URL) !== undefined &&
		['1', 'true'].includes(process.env.ANTHROPIC_INSECURE?.trim() ?? '')
			? { tls: { rejectUnauthorized: false } }
			: {}),
	}
	const response = yield* Effect.tryPromise({
		try: () =>
			upstreamFetch(rewriteAnthropicUrl(input, process.env.ANTHROPIC_BASE_URL), requestInit),
		catch: (cause) =>
			new AnthropicRequestError({
				message: cause instanceof Error ? cause.message : 'Anthropic request failed.',
				cause,
			}),
	})
	return transformAnthropicResponse(response)
})
