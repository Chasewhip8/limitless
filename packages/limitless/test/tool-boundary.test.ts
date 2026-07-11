import type { ToolContext } from '@opencode-ai/plugin'
import { Effect, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { ToolFailurePayload } from '../core/errors'
import { executeTool } from '../core/tool-boundary'
import { decodeArtifactSlug } from '../tools/artifacts/create'

const context: ToolContext = {
	sessionID: 'session',
	messageID: 'message',
	agent: 'limitless',
	directory: '/repo',
	worktree: '/repo',
	abort: new AbortController().signal,
	metadata: () => undefined,
	ask: () => {
		throw new Error('ask is not used by tool boundary tests')
	},
}

describe('executeTool schema boundary', () => {
	const Input = Schema.Struct({ value: Schema.String })
	const Result = Schema.Struct({
		ok: Schema.Literal(true),
		value: Schema.String.check(Schema.isMinLength(3)),
	})

	test('rejects malformed implementation output as a typed operation failure', async () => {
		const result = await executeTool(
			'boundary_test',
			Input,
			Result,
			{ value: 'valid' },
			context,
			() => Effect.succeed({ ok: true as const, value: 'x' }),
		)
		const payload = await Effect.runPromise(
			Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
				typeof result === 'string' ? result : result.output,
			).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ToolFailurePayload))),
		)

		expect(payload).toEqual({
			ok: false,
			error: 'ToolOperationError',
			tool: 'boundary_test',
			message: 'Tool implementation returned invalid output',
		})
	})

	test('serializes validated implementation output', async () => {
		const result = await executeTool(
			'boundary_test',
			Input,
			Result,
			{ value: 'valid' },
			context,
			(input) => Effect.succeed({ ok: true as const, value: input.value }),
		)

		expect(result).not.toEqual(expect.any(String))
		if (typeof result === 'string') throw new Error('expected structured tool result')
		expect(result.output).toBe('{\n  "ok": true,\n  "value": "valid"\n}')
		expect(result.metadata).toEqual({ ok: true, value: 'valid' })
	})

	test('serializes the encoded schema representation into output and metadata', async () => {
		const EncodedResult = Schema.Struct({ value: Schema.NumberFromString })
		const result = await executeTool(
			'encoded_boundary_test',
			Input,
			EncodedResult,
			{ value: 'valid' },
			context,
			() => Effect.succeed({ value: 42 }),
		)

		if (typeof result === 'string') throw new Error('expected structured tool result')
		expect(result.output).toBe('{\n  "value": "42"\n}')
		expect(result.metadata).toEqual({ value: '42' })
	})

	test('contains unexpected defects at the OpenCode boundary', async () => {
		const result = await executeTool(
			'defect_boundary_test',
			Input,
			Result,
			{ value: 'valid' },
			context,
			() => Effect.die(new Error('secret defect detail')),
		)

		if (typeof result === 'string') throw new Error('expected structured tool result')
		expect(result.metadata).toEqual({
			ok: false,
			error: 'ToolOperationError',
			tool: 'defect_boundary_test',
			message: 'Tool execution failed unexpectedly.',
		})
		expect(result.output).not.toContain('secret defect detail')
	})
})

describe('decodeArtifactSlug', () => {
	test('returns schema decoding effects without synchronous throws', async () => {
		await expect(Effect.runPromise(decodeArtifactSlug('example-brief'))).resolves.toBe(
			'example-brief',
		)
		await expect(Effect.runPromise(decodeArtifactSlug('../brief'))).rejects.toBeDefined()
	})
})
