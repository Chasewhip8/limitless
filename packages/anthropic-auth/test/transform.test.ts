import { describe, expect, it } from 'vitest'
import {
	buildBillingHeaderValue,
	computeCCH,
	computeVersionSuffix,
	extractFirstUserMessageText,
} from '../src/cch'
import { CLAUDE_CODE_IDENTITY } from '../src/constants'
import {
	type AnthropicBody,
	sanitizeSystemText,
	transformAnthropicBody,
	transformStreamEvent,
} from '../src/transform'

function requestBody(): AnthropicBody {
	return {
		model: 'claude-sonnet-4-5',
		stream: true,
		max_tokens: 4096,
		system: [
			{
				type: 'text',
				text: [
					'You are OpenCode, the best coding agent on the planet.',
					'',
					'Keep this paragraph.',
					'',
					'Here is some useful information about the environment you are running in:',
				].join('\n'),
			},
			{ type: 'text', text: '' },
		],
		messages: [
			{
				role: 'user',
				content: [{ type: 'text', text: 'hello world test message' }],
			},
			{
				role: 'assistant',
				content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} }],
			},
		],
		tools: [{ name: 'bash', description: 'Run a command', input_schema: { type: 'object' } }],
		tool_choice: { type: 'tool', name: 'write_file' },
	}
}

describe('Claude Code compatibility transforms', () => {
	it('keeps the upstream CCH vectors', () => {
		const messages = [{ role: 'user', content: 'hello world test message' }]
		expect(extractFirstUserMessageText(messages)).toBe('hello world test message')
		expect(computeCCH('hello world test message')).toBe('4ffc3')
		expect(computeVersionSuffix('hello world test message', '2.1.87')).toBe('6ff')
		expect(buildBillingHeaderValue(messages, '2.1.87', 'sdk-cli')).toBe(
			'x-anthropic-billing-header: cc_version=2.1.87.6ff; cc_entrypoint=sdk-cli; cch=4ffc3;',
		)
	})

	it('sanitizes system text with the upstream anchors and replacements', () => {
		expect(
			sanitizeSystemText(
				'You are OpenCode.\n\nKeep this.\n\nSee https://opencode.ai/docs now.\n\nif OpenCode honestly checks',
			),
		).toBe('Keep this.\n\nif the assistant honestly checks')
	})

	it('adds billing and identity blocks, retains empty blocks, and is system-idempotent', () => {
		const transformed = transformAnthropicBody(requestBody())
		expect(transformed.system?.map((block) => block.text)).toEqual([
			'x-anthropic-billing-header: cc_version=2.1.87.6ff; cc_entrypoint=sdk-cli; cch=4ffc3;',
			CLAUDE_CODE_IDENTITY,
			'Keep this paragraph.\n\nEnvironment context you are running in:',
			'',
		])

		const second = transformAnthropicBody({
			...transformed,
			tools: undefined,
			tool_choice: undefined,
			messages: transformed.messages.filter((message) => message.role !== 'assistant'),
		})
		expect(second.system?.filter((block) => block.text === CLAUDE_CODE_IDENTITY)).toHaveLength(1)
		expect(
			second.system?.filter((block) => block.text.startsWith('x-anthropic-billing-header:')),
		).toHaveLength(1)
	})

	it('uses identity alone when there are no user messages or system blocks', () => {
		const transformed = transformAnthropicBody({
			model: 'claude-sonnet-4-5',
			stream: true,
			max_tokens: 1024,
			messages: [],
		})
		expect(transformed.system).toEqual([{ type: 'text', text: CLAUDE_CODE_IDENTITY }])
	})

	it('prefixes definitions, assistant history, and named tool_choice exactly', () => {
		const transformed = transformAnthropicBody(requestBody())
		expect(transformed.tools?.[0]?.name).toBe('mcp_Bash')
		expect(transformed.tool_choice).toEqual({ type: 'tool', name: 'mcp_Write_file' })
		const assistant = transformed.messages.find((message) => message.role === 'assistant')
		expect(assistant?.content[0]).toMatchObject({ type: 'tool_use', name: 'mcp_Read_file' })
	})

	it('maps complete decoded content_block_start names structurally', () => {
		const transformed = transformStreamEvent({
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'tool-1', name: 'mcp_Bash', input: {} },
		})
		expect(transformed.content_block?.name).toBe('bash')
	})

	it('preserves StructuredOutput while lowercasing other prefixed names', () => {
		const structured = transformStreamEvent({
			type: 'content_block_start',
			content_block: { type: 'tool_use', name: 'mcp_StructuredOutput' },
		})
		expect(structured.content_block?.name).toBe('StructuredOutput')
	})
})
