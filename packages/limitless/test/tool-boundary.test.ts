import { Session } from '@opencode-ai/schema/session'
import { Tool } from '@opencode-ai/schema/tool'
import { Effect, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { toolInputError } from '../core/errors'
import { ToolExecutionContext } from '../core/execution'
import { makeSessionDirectoryResolver } from '../index'
import { defineLimitlessTool, encodeToolFailure, makeToolExecutor } from '../plugin/tool-boundary'
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
	test('uses the Effect client decoded session without decoding it a second time', async () => {
		const session = Schema.decodeUnknownSync(Session.Info)({
			id: 'ses_test',
			projectID: 'project_test',
			cost: 0,
			tokens: {
				input: 0,
				output: 0,
				reasoning: 0,
				cache: { read: 0, write: 0 },
			},
			time: { created: 0, updated: 0 },
			title: 'Test session',
			location: { directory: '/session/directory' },
		})
		const resolve = makeSessionDirectoryResolver({
			get: () => Effect.succeed(session),
		})

		expect(typeof session.time.created).toBe('object')
		expect(await Effect.runPromise(resolve(Session.ID.make('ses_test')))).toBe('/session/directory')
	})

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
		const definition = defineLimitlessTool({
			name: 'boundary_test',
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
			definition.execute({ value: 'ok' }, testToolContext(execution)),
		)
		expect(result.output).toEqual({
			value: 'ok',
			projectRoot: '/session/directory',
			sessionId: 'ses_test',
			agent: 'limitless',
		})
		expect(calls).toEqual(['ses_test'])
	})

	test('maps expected domain errors to typed Tool.Error metadata', async () => {
		const execution = testToolExecution('/project')
		const execute = makeToolExecutor(
			() => Effect.succeed('/project'),
			LspConfig.of({ servers: [] }),
		)
		const definition = defineLimitlessTool({
			name: 'failure_test',
			description: 'Failure test',
			input: Schema.Struct({}),
			output: Schema.String,
			execute: (input, context) =>
				execute(
					'failure_test',
					input,
					context,
					() => Effect.fail(toolInputError('failure_test', 'Useful model-visible failure')),
					encodeToolFailure,
				),
		})

		const failure = await Effect.runPromise(
			settleTestTool(definition, {}, execution).pipe(Effect.flip),
		)
		expect(failure).toBeInstanceOf(Tool.Error)
		expect(failure.message).toBe('Useful model-visible failure')
		expect(failure.metadata).toMatchObject({
			ok: false,
			error: 'ToolInputError',
			tool: 'failure_test',
		})
	})
})
