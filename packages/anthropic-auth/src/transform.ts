import type { AnthropicMessages } from '@opencode-ai/ai/protocols/anthropic-messages'
import { buildBillingHeaderValue } from './cch'
import {
	CLAUDE_CODE_ENTRYPOINT,
	CLAUDE_CODE_IDENTITY,
	OPENCODE_IDENTITY_PREFIX,
	PARAGRAPH_REMOVAL_ANCHORS,
	REQUIRED_BETAS,
	TEXT_REPLACEMENTS,
	TOOL_PREFIX,
} from './constants'

export type AnthropicBody = AnthropicMessages.AnthropicMessagesBody
export type AnthropicStreamEvent = Parameters<typeof AnthropicMessages.protocol.stream.step>[1]

const BILLING_PREFIX = 'x-anthropic-billing-header: '

export function prefixToolName(name: string): string {
	return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

export function unprefixToolName(name: string): string {
	if (!name.startsWith(TOOL_PREFIX)) return name
	const unprefixed = name.slice(TOOL_PREFIX.length)
	if (unprefixed === 'StructuredOutput') return unprefixed
	return `${unprefixed.charAt(0).toLowerCase()}${unprefixed.slice(1)}`
}

export function mergeBetaHeader(incoming: string | undefined): string {
	const existing = (incoming ?? '')
		.split(',')
		.map((value) => value.trim())
		.filter((value) => value.length > 0)
	return [...new Set([...REQUIRED_BETAS, ...existing])].join(',')
}

export function sanitizeSystemText(text: string): string {
	const paragraphs = text.split(/\n\n+/).filter((paragraph) => {
		if (paragraph.includes(OPENCODE_IDENTITY_PREFIX)) return false
		return !PARAGRAPH_REMOVAL_ANCHORS.some((anchor) => paragraph.includes(anchor))
	})
	return TEXT_REPLACEMENTS.reduce(
		(result, replacement) => result.replace(replacement.match, replacement.replacement),
		paragraphs.join('\n\n'),
	).trim()
}

export function transformAnthropicBody(body: AnthropicBody): AnthropicBody {
	const messages = body.messages.map((message) => {
		if (message.role !== 'assistant') return message
		return {
			...message,
			content: message.content.map((block) =>
				block.type === 'tool_use' && block.name
					? { ...block, name: prefixToolName(block.name) }
					: block,
			),
		}
	})
	const tools = body.tools?.map((tool) => ({
		...tool,
		name: tool.name ? prefixToolName(tool.name) : tool.name,
	}))
	const toolChoice =
		body.tool_choice?.type === 'tool' && body.tool_choice.name
			? { ...body.tool_choice, name: prefixToolName(body.tool_choice.name) }
			: body.tool_choice
	const sanitized = (body.system ?? [])
		.filter(
			(block) => block.text !== CLAUDE_CODE_IDENTITY && !block.text.startsWith(BILLING_PREFIX),
		)
		.map((block) => ({ ...block, text: sanitizeSystemText(block.text) }))
	const billing = messages.some((message) => message.role === 'user')
		? {
				type: 'text' as const,
				text: buildBillingHeaderValue(messages, undefined, CLAUDE_CODE_ENTRYPOINT),
			}
		: undefined
	const system = [
		...(billing === undefined ? [] : [billing]),
		{ type: 'text' as const, text: CLAUDE_CODE_IDENTITY },
		...sanitized,
	]

	return {
		...body,
		system,
		messages,
		tools,
		tool_choice: toolChoice,
	}
}

export function transformStreamEvent(event: AnthropicStreamEvent): AnthropicStreamEvent {
	const block = event.content_block
	if (event.type !== 'content_block_start' || !block?.name) return event
	return {
		...event,
		content_block: {
			...block,
			name: unprefixToolName(block.name),
		},
	}
}
