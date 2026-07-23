import { Tool } from '@opencode-ai/plugin/v2/effect/tool'
import { Effect, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { toolInputError } from '../core/errors'
import { ToolExecutionContext } from '../core/execution'
import { encodeToolFailure, makeToolExecutor } from '../plugin/tool-boundary'
import { LspConfig } from '../tools/lsp/config'
import { settleTestTool, testToolContext, testToolExecution } from './execution'

const BoundaryInput = Schema.Struct({ value: Schema.String })
const BoundaryOutput = Schema.Struct({
	value: Schema.String,
	projectRoot: Schema.String,
	sessionId: Schema.String,
	agent: Schema.String,
})

describe('OpenCode 2 tool execution boundary', () => {
	test('roots every call at session.location.directory and provides invocation identity', async () => {
		const calls: Array<string> = []
		const execution = testToolExecution('/ignored', 'ses_test')
		const execute = makeToolExecutor(
			(sessionID) =>
				Effect.sync(() => {
					calls.push(sessionID)
					return '/session/directory'
				}),
			LspConfig.of({ servers: [] }),
		)
		const definition = Tool.make({
			description: 'Boundary test',
			input: BoundaryInput,
			output: BoundaryOutput,
			execute: (input, context) =>
				execute(
					'boundary_test',
					input,
					context,
					(value) =>
						Effect.gen(function* () {
							const current = yield* ToolExecutionContext
							return BoundaryOutput.make({
								value: value.value,
								projectRoot: current.projectRoot,
								sessionId: current.sessionId,
								agent: current.agent,
							})
						}),
					encodeToolFailure,
				),
		})

		const result = await Effect.runPromise(
			Tool.settle(definition, { input: { value: 'ok' } }, testToolContext(execution)),
		)
		expect(result.structured).toEqual({
			value: 'ok',
			projectRoot: '/session/directory',
			sessionId: 'ses_test',
			agent: 'limitless',
		})
		expect(calls).toEqual(['ses_test'])
	})

	test('maps expected domain errors to typed Tool.Failure metadata', async () => {
		const execution = testToolExecution('/project')
		const execute = makeToolExecutor(
			() => Effect.succeed('/project'),
			LspConfig.of({ servers: [] }),
		)
		const definition = Tool.make({
			description: 'Failure test',
			input: Schema.Struct({}),
			output: Schema.String,
			execute: (input, context) =>
				execute(
					'failure_test',
					input,
					context,
					() => toolInputError('failure_test', 'Useful model-visible failure'),
					encodeToolFailure,
				),
		})

		const failure = await Effect.runPromise(
			settleTestTool(definition, {}, execution).pipe(Effect.flip),
		)
		expect(failure).toBeInstanceOf(Tool.Failure)
		expect(failure.message).toBe('Useful model-visible failure')
		expect(failure.metadata).toMatchObject({
			ok: false,
			error: 'ToolInputError',
			tool: 'failure_test',
		})
	})
})
