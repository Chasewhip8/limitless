import { watch } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Deferred, Effect, Fiber, Result, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { createProtocolConnection, ShutdownRequest } from 'vscode-languageserver-protocol/node'
import { toolOperationError } from '../core/errors'
import {
	ToolExecutionContext,
	type ToolExecutionContext as ToolExecutionContextType,
} from '../core/execution'
import { LspCallHierarchyResult } from '../tools/lsp/call-hierarchy'
import { decodeLspConfig, LspConfig, LspServerConfig, loadServerConfigs } from '../tools/lsp/config'
import { connectionResource, withDocument } from '../tools/lsp/connection'
import { LspDefinitionResult } from '../tools/lsp/definition'
import { LspToolFailurePayload } from '../tools/lsp/errors'
import { LspHoverResult } from '../tools/lsp/hover'
import { LspImplementationResult } from '../tools/lsp/implementation'
import { LspReferencesInput, LspReferencesResult, lspReferences } from '../tools/lsp/references'
import { LspRenameResult } from '../tools/lsp/rename'
import { LspSymbolsResult } from '../tools/lsp/symbols'
import { lspTools } from '../tools/lsp/tools'
import { settleTestTool, testToolExecution, testToolExecutor } from './execution'

const fakeServerPath = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url))
const sampleContent = 'const foo = 1\nfoo + foo\n'
const malformedMessageServer = [
	'const body = \'{"jsonrpc":"2.0","id":1,"result":\'',
	"process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\\r\\n\\r\\n' + body)",
	'process.stdin.resume()',
].join(';')

const FakeLspLogMessage = Schema.Struct({
	id: Schema.optional(Schema.Union([Schema.Int, Schema.String])),
	method: Schema.optional(Schema.String),
	params: Schema.optional(Schema.Unknown),
	result: Schema.optional(Schema.Unknown),
	error: Schema.optional(Schema.Struct({ code: Schema.Int, message: Schema.String })),
})
const FakeLspLogEntry = Schema.Struct({
	direction: Schema.optional(
		Schema.Union([Schema.Literal('clientToServer'), Schema.Literal('serverToClient')]),
	),
	event: Schema.optional(
		Schema.Union([
			Schema.Literal('processExit'),
			Schema.Literal('ignoredSigterm'),
			Schema.Literal('receivedSigterm'),
		]),
	),
	code: Schema.optional(Schema.Int),
	message: Schema.optional(FakeLspLogMessage),
})
type FakeLspLogEntry = typeof FakeLspLogEntry.Type

function context(worktree: string): ToolExecutionContextType {
	return testToolExecution(worktree)
}

function lspOptions(
	env: Record<string, string> = {},
	lsp: unknown = {
		fake: {
			command: [process.execPath, fakeServerPath],
			extensions: ['.ts'],
			env,
		},
	},
) {
	return { lsp }
}

function testPromise<T>(evaluate: () => Promise<T>) {
	return Effect.tryPromise({
		try: evaluate,
		catch: (error) => toolOperationError('lsp_test', 'Test operation failed', error),
	})
}

function readLspLog(filePath: string) {
	return testPromise(() =>
		readFile(filePath, 'utf8').then((content) =>
			content
				.trim()
				.split('\n')
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line)),
		),
	).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(FakeLspLogEntry))))
}

function clientMethods(entries: ReadonlyArray<FakeLspLogEntry>): ReadonlyArray<string> {
	return entries.flatMap((entry) =>
		entry.direction === 'clientToServer' && entry.message?.method !== undefined
			? [entry.message.method]
			: [],
	)
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ESRCH') {
			return false
		}
		throw error
	}
}

function withWorkspace<T, E, R>(body: (workspace: string) => Effect.Effect<T, E, R>) {
	return Effect.scoped(
		Effect.gen(function* () {
			const workspace = yield* Effect.acquireRelease(
				testPromise(() => mkdtemp(path.join(os.tmpdir(), 'limitless-lsp-'))),
				(workspace) =>
					testPromise(() => rm(workspace, { recursive: true, force: true })).pipe(
						Effect.match({ onFailure: () => undefined, onSuccess: () => undefined }),
					),
			)
			yield* testPromise(() => writeFile(path.join(workspace, 'sample.ts'), sampleContent))
			yield* testPromise(() => writeFile(path.join(workspace, 'sample.py'), sampleContent))
			return yield* body(workspace)
		}),
	)
}

function runLspTool(
	name: keyof ReturnType<typeof lspTools>,
	workspace: string,
	input: unknown,
	env: Record<string, string> = {},
	lsp?: unknown,
) {
	const ctx = context(workspace)
	return Effect.gen(function* () {
		const config = yield* decodeLspConfig(lspOptions(env, lsp))
		const result = yield* Effect.result(
			settleTestTool(lspTools(testToolExecutor(ctx, config.servers))[name], input, ctx),
		)
		if (Result.isSuccess(result)) return result.success.output
		return (
			result.failure.metadata ?? {
				error: result.failure._tag,
				message: result.failure.message,
			}
		)
	})
}

function runReferences(
	workspace: string,
	input: unknown,
	env: Record<string, string> = {},
	lsp?: unknown,
) {
	return runLspTool('lsp_references', workspace, input, env, lsp)
}

function runDefinition(
	workspace: string,
	input: unknown,
	env: Record<string, string> = {},
	lsp?: unknown,
) {
	return runLspTool('lsp_definition', workspace, input, env, lsp)
}

function runHover(workspace: string, input: unknown, env: Record<string, string> = {}) {
	return runLspTool('lsp_hover', workspace, input, env)
}

function runImplementation(workspace: string, input: unknown, env: Record<string, string> = {}) {
	return runLspTool('lsp_implementation', workspace, input, env)
}

function runCallHierarchy(workspace: string, input: unknown, env: Record<string, string> = {}) {
	return runLspTool('lsp_call_hierarchy', workspace, input, env)
}

function runSymbols(workspace: string, input: unknown, env: Record<string, string> = {}) {
	return runLspTool('lsp_symbols', workspace, input, env)
}

function runRename(workspace: string, input: unknown, env: Record<string, string> = {}) {
	return runLspTool('lsp_rename', workspace, input, env)
}

describe('LSP tools', () => {
	test('reads generated Limitless LSP options through the injected capability', () =>
		Effect.runPromise(
			withWorkspace(() =>
				Effect.gen(function* () {
					const config = yield* decodeLspConfig(lspOptions())
					const configs = yield* loadServerConfigs('lsp_test').pipe(
						Effect.provideService(LspConfig, config),
					)
					expect(configs.map((config) => config.id)).toEqual(['fake'])
				}),
			),
		))

	test('request write failures do not escape as unhandled rejections', () =>
		Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const unhandled: Array<unknown> = []
					const onUnhandled = (reason: unknown) => unhandled.push(reason)
					const resources = yield* Effect.acquireRelease(
						Effect.sync(() => {
							const input = new PassThrough()
							const output = new Writable({
								write: (_chunk, _encoding, callback) =>
									callback(new Error('forced LSP write failure')),
							})
							const connection = createProtocolConnection(input, output)
							connection.listen()
							process.on('unhandledRejection', onUnhandled)
							return { connection, input, output }
						}),
						({ connection, input, output }) =>
							Effect.sync(() => {
								process.off('unhandledRejection', onUnhandled)
								connection.dispose()
								input.destroy()
								output.destroy()
							}),
					)
					const result = yield* Effect.result(
						testPromise(() => resources.connection.sendRequest(ShutdownRequest.type)),
					)
					yield* testPromise(() => new Promise<void>((resolve) => setImmediate(resolve)))

					expect(Result.isFailure(result)).toBe(true)
					expect(unhandled).toEqual([])
				}),
			),
		))

	test('definition aggregates every supported relationship, deduplicates, and tags locations', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const logPath = path.join(workspace, 'definition.log')
					const raw = yield* runDefinition(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_LOG: logPath },
					)
					const payload = yield* Schema.decodeUnknownEffect(LspDefinitionResult)(raw)

					expect(payload).toMatchObject({
						ok: true,
						tool: 'lsp_definition',
						server: 'fake',
						filePath: 'sample.ts',
						unsupportedRelationships: [],
						errors: [],
						truncated: false,
					})
					expect(payload.locations).toHaveLength(3)
					expect(payload.locations).toEqual([
						expect.objectContaining({
							filePath: 'sample.ts',
							text: 'foo',
							relationships: ['definition', 'declaration'],
						}),
						expect.objectContaining({
							filePath: 'sample.ts',
							text: 'foo',
							relationships: ['definition', 'declaration', 'typeDefinition'],
						}),
						expect.objectContaining({
							filePath: 'sample.ts',
							text: 'foo',
							relationships: ['typeDefinition'],
						}),
					])
					const entries = yield* readLspLog(logPath)
					const methods = clientMethods(entries)
					expect(methods.filter((method) => method === 'initialize')).toHaveLength(1)
					expect(methods).toEqual(
						expect.arrayContaining([
							'textDocument/definition',
							'textDocument/declaration',
							'textDocument/typeDefinition',
						]),
					)
					const initialize = entries.find(
						(entry) =>
							entry.direction === 'clientToServer' && entry.message?.method === 'initialize',
					)?.message
					expect(initialize?.params).toMatchObject({
						capabilities: {
							textDocument: {
								callHierarchy: {},
								declaration: { linkSupport: true },
								definition: { linkSupport: true },
								hover: { contentFormat: ['markdown', 'plaintext'] },
								implementation: { linkSupport: true },
								typeDefinition: { linkSupport: true },
							},
						},
					})
				}),
			),
		))

	test('definition preserves partial success and reports unsupported and failed relationships', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runDefinition(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{
							FAKE_LSP_NO_DECLARATION_CAPABILITY: '1',
							FAKE_LSP_TYPE_DEFINITION_ERROR: '1',
						},
					)
					const payload = yield* Schema.decodeUnknownEffect(LspDefinitionResult)(raw)

					expect(payload.unsupportedRelationships).toEqual(['declaration'])
					expect(payload.errors).toEqual([
						expect.objectContaining({
							relationship: 'typeDefinition',
							message: expect.stringContaining('forced type definition failure'),
						}),
					])
					expect(payload.locations).toHaveLength(2)
					for (const location of payload.locations) {
						expect(location.relationships).toEqual(['definition'])
					}
				}),
			),
		))

	test('definition applies maxResults after relationship deduplication', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runDefinition(workspace, {
						filePath: 'sample.ts',
						offset: 6,
						maxResults: 1,
					})
					const payload = yield* Schema.decodeUnknownEffect(LspDefinitionResult)(raw)
					expect(payload.locations).toHaveLength(1)
					expect(payload.locations[0]?.relationships).toEqual(['definition', 'declaration'])
					expect(payload.truncated).toBe(true)
				}),
			),
		))

	test('definition fails only when no relationship is supported or every attempt fails', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const unsupportedRaw = yield* runDefinition(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{
							FAKE_LSP_NO_DEFINITION_CAPABILITY: '1',
							FAKE_LSP_NO_DECLARATION_CAPABILITY: '1',
							FAKE_LSP_NO_TYPE_DEFINITION_CAPABILITY: '1',
						},
					)
					const unsupported =
						yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(unsupportedRaw)
					expect(unsupported.tool).toBe('lsp_definition')
					expect(unsupported.message).toContain('No candidate LSP server supports')

					const failedRaw = yield* runDefinition(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{
							FAKE_LSP_DEFINITION_ERROR: '1',
							FAKE_LSP_DECLARATION_ERROR: '1',
							FAKE_LSP_TYPE_DEFINITION_ERROR: '1',
						},
					)
					const failed = yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(failedRaw)
					expect(failed.tool).toBe('lsp_definition')
					expect(failed.message).toContain('Every attempted definition relationship failed')
					expect(failed.message).toContain('forced definition failure')
				}),
			),
		))

	test('definition falls through a failed candidate and reruns comprehensively on one connection', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runDefinition(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{},
						{
							failing: {
								command: [process.execPath, fakeServerPath],
								extensions: ['.ts'],
								env: {
									FAKE_LSP_DEFINITION_ERROR: '1',
									FAKE_LSP_DECLARATION_ERROR: '1',
									FAKE_LSP_TYPE_DEFINITION_ERROR: '1',
								},
							},
							working: {
								command: [process.execPath, fakeServerPath],
								extensions: ['.ts'],
							},
						},
					)
					const payload = yield* Schema.decodeUnknownEffect(LspDefinitionResult)(raw)
					expect(payload.server).toBe('working')
					expect(payload.locations).toHaveLength(3)
					expect(payload.errors).toEqual([])
				}),
			),
		))

	test('definition runtime-decodes malformed relationship results without losing valid ones', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runDefinition(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_MALFORMED_DECLARATION: '1' },
					)
					const payload = yield* Schema.decodeUnknownEffect(LspDefinitionResult)(raw)
					expect(payload.locations.length).toBeGreaterThan(0)
					expect(payload.errors).toEqual([
						expect.objectContaining({
							relationship: 'declaration',
							message: expect.stringContaining('Invalid declaration response'),
						}),
					])
				}),
			),
		))

	test('definition treats location normalization failure as a relationship error', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runDefinition(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{
							FAKE_LSP_INVALID_DECLARATION_URI: '1',
							FAKE_LSP_NO_TYPE_DEFINITION_CAPABILITY: '1',
						},
					)
					const payload = yield* Schema.decodeUnknownEffect(LspDefinitionResult)(raw)

					expect(payload.locations).toHaveLength(2)
					for (const location of payload.locations) {
						expect(location.relationships).toEqual(['definition'])
					}
					expect(payload.errors).toEqual([
						expect.objectContaining({
							relationship: 'declaration',
							message: expect.stringContaining('invalid file URI'),
						}),
					])
				}),
			),
		))

	test('definition accepts singular, null, and empty relationship responses', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					for (const testCase of [
						{ variant: { FAKE_LSP_DEFINITION_SINGULAR: '1' }, expected: 1 },
						{ variant: { FAKE_LSP_DEFINITION_NULL: '1' }, expected: 0 },
						{ variant: { FAKE_LSP_DEFINITION_EMPTY: '1' }, expected: 0 },
					] as const) {
						const raw = yield* runDefinition(
							workspace,
							{ filePath: 'sample.ts', offset: 6 },
							{
								...testCase.variant,
								FAKE_LSP_NO_DECLARATION_CAPABILITY: '1',
								FAKE_LSP_NO_TYPE_DEFINITION_CAPABILITY: '1',
							},
						)
						const payload = yield* Schema.decodeUnknownEffect(LspDefinitionResult)(raw)
						expect(payload.locations).toHaveLength(testCase.expected)
						expect(payload.errors).toEqual([])
						if (testCase.expected === 1)
							expect(payload.locations[0]).toMatchObject({
								text: 'foo',
								relationships: ['definition'],
							})
					}
				}),
			),
		))

	test('definition enforces one deadline across sequential relationships', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const logPath = path.join(workspace, 'definition-deadline.log')
					const raw = yield* runDefinition(
						workspace,
						{ filePath: 'sample.ts', offset: 6, timeoutMs: 250 },
						{ FAKE_LSP_HOLD_TYPE_DEFINITION: '1', FAKE_LSP_LOG: logPath },
					)
					const payload = yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(raw)
					expect(payload).toMatchObject({ tool: 'lsp_definition', server: 'fake' })
					expect(payload.message).toContain('Definition relationships timed out after 250ms')
					const entries = yield* readLspLog(logPath)
					expect(clientMethods(entries)).toContain('$/cancelRequest')
					expect(entries).toContainEqual(expect.objectContaining({ event: 'processExit', code: 0 }))
				}),
			),
		))

	test('hover normalizes MarkupContent and every legacy MarkedString form', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const cases = [
						{
							mode: 'markup-markdown',
							contents: [{ kind: 'markdown', value: '**foo** docs' }],
						},
						{
							mode: 'markup-plaintext',
							contents: [{ kind: 'plaintext', value: 'foo docs' }],
						},
						{
							mode: 'legacy-string',
							contents: [{ kind: 'markdown', value: '**legacy foo**' }],
						},
						{
							mode: 'legacy-code',
							contents: [{ kind: 'code', language: 'typescript', value: 'const foo: number' }],
						},
					] as const
					for (const testCase of cases) {
						const raw = yield* runHover(
							workspace,
							{ filePath: 'sample.ts', offset: 6 },
							{ FAKE_LSP_HOVER_MODE: testCase.mode },
						)
						const payload = yield* Schema.decodeUnknownEffect(LspHoverResult)(raw)
						expect(payload.hover?.contents).toEqual(testCase.contents)
						expect(payload.hover?.range).toEqual({
							start: { line: 0, character: 6 },
							end: { line: 0, character: 9 },
						})
					}

					const arrayRaw = yield* runHover(workspace, { filePath: 'sample.ts', offset: 6 })
					const arrayPayload = yield* Schema.decodeUnknownEffect(LspHoverResult)(arrayRaw)
					expect(arrayPayload.hover?.contents).toEqual([
						{ kind: 'markdown', value: '**legacy foo**' },
						{ kind: 'code', language: 'typescript', value: 'const foo: number' },
					])

					const emptyRaw = yield* runHover(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_HOVER_MODE: 'legacy-empty' },
					)
					const emptyPayload = yield* Schema.decodeUnknownEffect(LspHoverResult)(emptyRaw)
					expect(emptyPayload.hover).toEqual({ contents: [] })
				}),
			),
		))

	test('hover returns null explicitly and rejects unsupported or malformed responses', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const nullRaw = yield* runHover(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_HOVER_MODE: 'null' },
					)
					const nullPayload = yield* Schema.decodeUnknownEffect(LspHoverResult)(nullRaw)
					expect(nullPayload.hover).toBeNull()

					const unsupportedRaw = yield* runHover(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_NO_HOVER_CAPABILITY: '1' },
					)
					const unsupported =
						yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(unsupportedRaw)
					expect(unsupported.message).toContain('hoverProvider')

					const malformedRaw = yield* runHover(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_MALFORMED_HOVER: '1' },
					)
					const malformed = yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(malformedRaw)
					expect(malformed.tool).toBe('lsp_hover')
					expect(malformed.message).toContain('Invalid hover response')
				}),
			),
		))

	test('implementation normalizes and deduplicates locations before applying maxResults', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runImplementation(workspace, {
						filePath: 'sample.ts',
						offset: 6,
						maxResults: 1,
					})
					const payload = yield* Schema.decodeUnknownEffect(LspImplementationResult)(raw)
					expect(payload).toMatchObject({
						ok: true,
						tool: 'lsp_implementation',
						server: 'fake',
						filePath: 'sample.ts',
						truncated: true,
					})
					expect(payload.locations).toEqual([
						expect.objectContaining({ filePath: 'sample.ts', text: 'foo' }),
					])

					const locationsRaw = yield* runImplementation(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_IMPLEMENTATION_LOCATIONS: '1' },
					)
					const locationsPayload =
						yield* Schema.decodeUnknownEffect(LspImplementationResult)(locationsRaw)
					expect(locationsPayload.locations).toHaveLength(2)
					expect(locationsPayload.truncated).toBe(false)
				}),
			),
		))

	test('implementation handles singular, null, and empty navigation responses', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					for (const testCase of [
						{ env: { FAKE_LSP_IMPLEMENTATION_SINGULAR: '1' }, expected: 1 },
						{ env: { FAKE_LSP_IMPLEMENTATION_NULL: '1' }, expected: 0 },
						{ env: { FAKE_LSP_IMPLEMENTATION_EMPTY: '1' }, expected: 0 },
					] as const) {
						const raw = yield* runImplementation(
							workspace,
							{ filePath: 'sample.ts', offset: 6 },
							testCase.env,
						)
						const payload = yield* Schema.decodeUnknownEffect(LspImplementationResult)(raw)
						expect(payload.locations).toHaveLength(testCase.expected)
						expect(payload.truncated).toBe(false)
					}
				}),
			),
		))

	test('implementation reports capability, protocol, and runtime decoding errors publicly', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const cases = [
						{
							env: { FAKE_LSP_NO_IMPLEMENTATION_CAPABILITY: '1' },
							message: 'implementationProvider',
						},
						{
							env: { FAKE_LSP_IMPLEMENTATION_ERROR: '1' },
							message: 'forced implementation failure',
						},
						{
							env: { FAKE_LSP_MALFORMED_IMPLEMENTATION: '1' },
							message: 'Invalid implementation response',
						},
					]
					for (const testCase of cases) {
						const raw = yield* runImplementation(
							workspace,
							{ filePath: 'sample.ts', offset: 6 },
							testCase.env,
						)
						const payload = yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(raw)
						expect(payload.tool).toBe('lsp_implementation')
						expect(payload.message).toContain(testCase.message)
					}
				}),
			),
		))

	test('call hierarchy queries both directions for every exact prepared item and cleans up', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const logPath = path.join(workspace, 'call-hierarchy.log')
					const raw = yield* runCallHierarchy(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_LOG: logPath },
					)
					const payload = yield* Schema.decodeUnknownEffect(LspCallHierarchyResult)(raw)

					expect(payload).toMatchObject({
						ok: true,
						tool: 'lsp_call_hierarchy',
						server: 'fake',
						filePath: 'sample.ts',
						prepareStatus: 'items',
						truncated: false,
					})
					expect(payload.preparedItems).toHaveLength(2)
					expect(payload.preparedItems.map(({ item }) => item.name)).toEqual(['foo', 'bar'])
					for (const prepared of payload.preparedItems) {
						expect(prepared.item.filePath).toBe('sample.ts')
						expect(prepared.item.range).toBeDefined()
						expect(prepared.item.selectionRange).toBeDefined()
						expect(prepared.incomingCalls).toHaveLength(1)
						expect(prepared.outgoingCalls).toHaveLength(1)
						expect(prepared.incomingCalls[0]?.from.filePath).toBe('sample.ts')
						expect(prepared.incomingCalls[0]?.fromRanges).toHaveLength(1)
						expect(prepared.outgoingCalls[0]?.to.filePath).toBe('sample.ts')
						expect(prepared.outgoingCalls[0]?.fromRanges).toHaveLength(1)
						expect(prepared.errors).toEqual([])
					}
					const entries = yield* readLspLog(logPath)
					const methods = clientMethods(entries)
					expect(methods.filter((method) => method === 'callHierarchy/incomingCalls')).toHaveLength(
						2,
					)
					expect(methods.filter((method) => method === 'callHierarchy/outgoingCalls')).toHaveLength(
						2,
					)
					expect(entries).toContainEqual(expect.objectContaining({ event: 'processExit', code: 0 }))
				}),
			),
		))

	test('call hierarchy preserves all prepared groups while globally limiting calls', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runCallHierarchy(workspace, {
						filePath: 'sample.ts',
						offset: 6,
						maxResults: 1,
					})
					const payload = yield* Schema.decodeUnknownEffect(LspCallHierarchyResult)(raw)
					expect(payload.preparedItems).toHaveLength(2)
					expect(
						payload.preparedItems.reduce(
							(total, item) => total + item.incomingCalls.length + item.outgoingCalls.length,
							0,
						),
					).toBe(1)
					expect(payload.truncated).toBe(true)
					expect(payload.preparedItems.some((item) => item.truncated)).toBe(true)
				}),
			),
		))

	test('call hierarchy preserves directional partial success and malformed-response errors', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const failedRaw = yield* runCallHierarchy(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_INCOMING_CALLS_ERROR: '1' },
					)
					const failed = yield* Schema.decodeUnknownEffect(LspCallHierarchyResult)(failedRaw)
					for (const prepared of failed.preparedItems) {
						expect(prepared.incomingCalls).toEqual([])
						expect(prepared.outgoingCalls).toHaveLength(1)
						expect(prepared.errors).toEqual([
							expect.objectContaining({
								direction: 'incoming',
								message: expect.stringContaining('forced incoming calls failure'),
							}),
						])
					}

					const malformedRaw = yield* runCallHierarchy(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_MALFORMED_OUTGOING_CALLS: '1' },
					)
					const malformed = yield* Schema.decodeUnknownEffect(LspCallHierarchyResult)(malformedRaw)
					for (const prepared of malformed.preparedItems) {
						expect(prepared.incomingCalls).toHaveLength(1)
						expect(prepared.outgoingCalls).toEqual([])
						expect(prepared.errors[0]).toMatchObject({
							direction: 'outgoing',
							message: expect.stringContaining('Invalid outgoing call hierarchy response'),
						})
					}
				}),
			),
		))

	test('call hierarchy handles independently null incoming and outgoing responses', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					for (const testCase of [
						{ env: { FAKE_LSP_INCOMING_CALLS_NULL: '1' }, empty: 'incoming' },
						{ env: { FAKE_LSP_OUTGOING_CALLS_NULL: '1' }, empty: 'outgoing' },
					] as const) {
						const raw = yield* runCallHierarchy(
							workspace,
							{ filePath: 'sample.ts', offset: 6 },
							testCase.env,
						)
						const payload = yield* Schema.decodeUnknownEffect(LspCallHierarchyResult)(raw)
						for (const prepared of payload.preparedItems) {
							expect(prepared.errors).toEqual([])
							expect(prepared.incomingCalls).toHaveLength(testCase.empty === 'incoming' ? 0 : 1)
							expect(prepared.outgoingCalls).toHaveLength(testCase.empty === 'outgoing' ? 0 : 1)
						}
					}
				}),
			),
		))

	test('call hierarchy enforces one deadline across prepare and follow-up requests', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const logPath = path.join(workspace, 'call-hierarchy-deadline.log')
					const raw = yield* runCallHierarchy(
						workspace,
						{ filePath: 'sample.ts', offset: 6, timeoutMs: 250 },
						{ FAKE_LSP_HOLD_OUTGOING_CALLS: '1', FAKE_LSP_LOG: logPath },
					)
					const payload = yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(raw)
					expect(payload).toMatchObject({ tool: 'lsp_call_hierarchy', server: 'fake' })
					expect(payload.message).toContain('Call hierarchy requests timed out after 250ms')
					const entries = yield* readLspLog(logPath)
					expect(clientMethods(entries)).toContain('$/cancelRequest')
					expect(entries).toContainEqual(expect.objectContaining({ event: 'processExit', code: 0 }))
				}),
			),
		))

	test('call hierarchy handles null and empty prepare results explicitly', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					for (const testCase of [
						{ env: { FAKE_LSP_CALL_PREPARE_NULL: '1' }, status: 'null' },
						{ env: { FAKE_LSP_CALL_PREPARE_EMPTY: '1' }, status: 'empty' },
					] as const) {
						const raw = yield* runCallHierarchy(
							workspace,
							{ filePath: 'sample.ts', offset: 6 },
							testCase.env,
						)
						const payload = yield* Schema.decodeUnknownEffect(LspCallHierarchyResult)(raw)
						expect(payload.prepareStatus).toBe(testCase.status)
						expect(payload.preparedItems).toEqual([])
						expect(payload.truncated).toBe(false)
					}
				}),
			),
		))

	test('call hierarchy rejects unsupported capability and malformed prepare responses', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const unsupportedRaw = yield* runCallHierarchy(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_NO_CALL_HIERARCHY_CAPABILITY: '1' },
					)
					const unsupported =
						yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(unsupportedRaw)
					expect(unsupported.message).toContain('callHierarchyProvider')

					const malformedRaw = yield* runCallHierarchy(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_MALFORMED_CALL_PREPARE: '1' },
					)
					const malformed = yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(malformedRaw)
					expect(malformed.tool).toBe('lsp_call_hierarchy')
					expect(malformed.message).toContain('Invalid prepare call hierarchy response')
				}),
			),
		))

	test('references return workspace-relative locations with source text', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runReferences(workspace, { filePath: 'sample.ts', offset: 6 })
					const payload = yield* Schema.decodeUnknownEffect(LspReferencesResult)(raw)

					expect(payload).toMatchObject({
						ok: true,
						server: 'fake',
						filePath: 'sample.ts',
						truncated: false,
					})
					expect(payload.locations.length).toBeGreaterThan(0)
					for (const location of payload.locations) {
						expect(location.filePath).toBe('sample.ts')
						expect(location.range).toMatchObject({
							start: expect.objectContaining({
								line: expect.any(Number),
								character: expect.any(Number),
							}),
							end: expect.objectContaining({
								line: expect.any(Number),
								character: expect.any(Number),
							}),
						})
					}
					expect(payload.locations[0]).toMatchObject({ text: 'foo' })
				}),
			),
		))

	test('references respect maxResults', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runReferences(workspace, {
						filePath: 'sample.ts',
						offset: 6,
						maxResults: 1,
					})
					const payload = yield* Schema.decodeUnknownEffect(LspReferencesResult)(raw)

					expect(payload.locations).toHaveLength(1)
					expect(payload.truncated).toBe(true)
				}),
			),
		))

	test('references preserve duplicates and apply maxResults to original server ordering', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const allRaw = yield* runReferences(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_DUPLICATE_REFERENCES: '1' },
					)
					const all = yield* Schema.decodeUnknownEffect(LspReferencesResult)(allRaw)
					expect(all.locations.map((location) => location.range.start.line)).toEqual([0, 1, 0])
					expect(all.locations[0]).toEqual(all.locations[2])
					expect(all.truncated).toBe(false)

					const limitedRaw = yield* runReferences(
						workspace,
						{ filePath: 'sample.ts', offset: 6, maxResults: 2 },
						{ FAKE_LSP_DUPLICATE_REFERENCES: '1' },
					)
					const limited = yield* Schema.decodeUnknownEffect(LspReferencesResult)(limitedRaw)
					expect(limited.locations.map((location) => location.range.start.line)).toEqual([0, 1])
					expect(limited.truncated).toBe(true)
				}),
			),
		))

	test('references reject offsets outside the file', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runReferences(workspace, {
						filePath: 'sample.ts',
						offset: 9_999,
					})
					const payload = yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(raw)

					expect(payload.message).toEqual(expect.stringContaining('Offset'))
				}),
			),
		))

	test('references require a matching server extension', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runReferences(workspace, { filePath: 'sample.py', offset: 6 })
					const payload = yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(raw)

					expect(payload.message).toEqual(
						expect.stringContaining('No configured LSP server matches'),
					)
				}),
			),
		))

	test('references require the server capability', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runReferences(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_NO_REFERENCES_CAPABILITY: '1' },
					)
					const payload = yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(raw)

					expect(payload.message).toEqual(expect.stringContaining('referencesProvider'))
				}),
			),
		))

	test('references report request timeouts', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const logPath = path.join(workspace, 'timeout-lsp.log')
					const raw = yield* runReferences(
						workspace,
						{ filePath: 'sample.ts', offset: 6, timeoutMs: 300 },
						{
							FAKE_LSP_HOLD_REFERENCES: '1',
							FAKE_LSP_LATE_RESPONSE: '1',
							FAKE_LSP_LOG: logPath,
						},
					)
					const payload = yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(raw)

					expect(payload.message).toEqual(expect.stringContaining('timed out'))
					const entries = yield* readLspLog(logPath)
					const methods = clientMethods(entries)
					const lifecycle = [
						'textDocument/references',
						'$/cancelRequest',
						'textDocument/didClose',
						'shutdown',
						'exit',
					]
					for (let index = 1; index < lifecycle.length; index += 1) {
						expect(methods.indexOf(lifecycle[index] ?? '')).toBeGreaterThan(
							methods.indexOf(lifecycle[index - 1] ?? ''),
						)
					}
					const referenceRequest = entries.find(
						(entry) =>
							entry.direction === 'clientToServer' &&
							entry.message?.method === 'textDocument/references',
					)?.message
					expect(referenceRequest?.id).toBeDefined()
					const didCloseIndex = entries.findIndex(
						(entry) =>
							entry.direction === 'clientToServer' &&
							entry.message?.method === 'textDocument/didClose',
					)
					const lateResponseIndex = entries.findIndex(
						(entry) =>
							entry.direction === 'serverToClient' &&
							entry.message?.id === referenceRequest?.id &&
							entry.message?.result !== undefined,
					)
					expect(lateResponseIndex).toBeGreaterThan(didCloseIndex)
					expect(entries).toContainEqual(expect.objectContaining({ event: 'processExit', code: 0 }))
				}),
			),
		))

	test(
		'bounds stalled notification writes and reaches process termination fallback',
		() =>
			Effect.runPromise(
				withWorkspace((workspace) =>
					Effect.gen(function* () {
						const logPath = path.join(workspace, 'stalled-writer.log')
						const pidPath = path.join(workspace, 'stalled-writer.pid')
						const filePath = path.join(workspace, 'sample.ts')
						yield* testPromise(() => writeFile(filePath, 'x'.repeat(4 * 1024 * 1024)))
						const config = LspServerConfig.make({
							id: 'fake',
							command: [process.execPath, fakeServerPath],
							extensions: ['.ts'],
							env: {
								FAKE_LSP_LOG: logPath,
								FAKE_LSP_LOG_SIGTERM: '1',
								FAKE_LSP_PID_FILE: pidPath,
								FAKE_LSP_STALL_AFTER_INITIALIZE: '1',
							},
							languageIds: {},
						})
						const result = yield* Effect.result(
							Effect.scoped(
								Effect.gen(function* () {
									const connection = yield* connectionResource(
										'lsp_references',
										config,
										workspace,
										300,
									)
									return yield* withDocument(
										'lsp_references',
										connection,
										filePath,
										300,
										() => Effect.void,
									)
								}),
							),
						)
						const pid = Number(yield* testPromise(() => readFile(pidPath, 'utf8')))

						expect(Result.isFailure(result)).toBe(true)
						if (Result.isFailure(result)) {
							expect(result.failure).toMatchObject({
								tool: 'lsp_references',
								server: 'fake',
								message: 'textDocument/didOpen timed out after 300ms.',
							})
						}
						expect(processExists(pid)).toBe(false)
						const entries = yield* readLspLog(logPath)
						expect(entries).toContainEqual(expect.objectContaining({ event: 'receivedSigterm' }))
					}),
				),
			),
		10_000,
	)

	test('cancellation interrupts scoped server work', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const ctx = context(workspace)
					const markerName = 'cancel-dispatched'
					const markerPath = path.join(workspace, markerName)
					const logPath = path.join(workspace, 'cancel-lsp.log')
					const dispatched = yield* Deferred.make<void>()
					yield* Effect.acquireRelease(
						Effect.sync(() =>
							watch(workspace, (_event, fileName) => {
								if (fileName?.toString() === markerName)
									Deferred.doneUnsafe(dispatched, Effect.void)
							}),
						),
						(fileWatcher) => Effect.sync(() => fileWatcher.close()),
					)
					const config = yield* decodeLspConfig(
						lspOptions({
							FAKE_LSP_HOLD_REFERENCES: '1',
							FAKE_LSP_LATE_RESPONSE: '1',
							FAKE_LSP_LOG: logPath,
							FAKE_LSP_REQUEST_MARKER: markerPath,
						}),
					)
					const fiber = yield* lspReferences(
						LspReferencesInput.make({ filePath: 'sample.ts', offset: 6 }),
					).pipe(
						Effect.provideService(LspConfig, config),
						Effect.provideService(ToolExecutionContext, ctx),
						Effect.forkChild,
					)
					yield* Deferred.await(dispatched)
					yield* Fiber.interrupt(fiber)

					const entries = yield* readLspLog(logPath)
					const methods = clientMethods(entries)
					expect(methods.indexOf('$/cancelRequest')).toBeGreaterThan(
						methods.indexOf('textDocument/references'),
					)
					expect(methods.indexOf('textDocument/didClose')).toBeGreaterThan(
						methods.indexOf('$/cancelRequest'),
					)
					expect(entries).toContainEqual(expect.objectContaining({ event: 'processExit', code: 0 }))
				}),
			),
		))

	test('references report servers that exit early', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runReferences(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_EXIT_EARLY: '1' },
					)
					const payload = yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(raw)

					expect(payload.message).toMatch(/exited|closed/iu)
				}),
			),
		))

	test('consumes a final valid response before treating process close as terminal', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runReferences(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_EXIT_AFTER_REFERENCES_RESPONSE: '1' },
					)
					const payload = yield* Schema.decodeUnknownEffect(LspReferencesResult)(raw)
					expect(payload.locations).toEqual([
						expect.objectContaining({ filePath: 'sample.ts', text: 'foo' }),
					])
				}),
			),
		))

	test('escalates to SIGKILL and waits for process cleanup', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const logPath = path.join(workspace, 'forced-cleanup.log')
					const pidPath = path.join(workspace, 'forced-cleanup.pid')
					const raw = yield* runReferences(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{
							FAKE_LSP_IGNORE_EXIT: '1',
							FAKE_LSP_IGNORE_SIGTERM: '1',
							FAKE_LSP_LOG: logPath,
							FAKE_LSP_PID_FILE: pidPath,
						},
					)
					const payload = yield* Schema.decodeUnknownEffect(LspReferencesResult)(raw)
					const pid = Number(yield* testPromise(() => readFile(pidPath, 'utf8')))

					expect(payload.ok).toBe(true)
					expect(Number.isSafeInteger(pid)).toBe(true)
					expect(processExists(pid)).toBe(false)
					const entries = yield* readLspLog(logPath)
					expect(entries).toContainEqual(expect.objectContaining({ event: 'ignoredSigterm' }))
				}),
			),
		))

	test('rejects malformed generated server options during plugin activation', () =>
		Effect.runPromise(
			withWorkspace(() =>
				Effect.gen(function* () {
					const result = yield* Effect.result(
						decodeLspConfig(
							lspOptions(
								{},
								{
									fake: {
										command: [process.execPath, fakeServerPath],
										extensions: ['.ts'],
										initialization: 42,
									},
								},
							),
						),
					)

					expect(Result.isFailure(result)).toBe(true)
					if (Result.isFailure(result)) {
						expect(result.failure.message).toContain('Invalid Limitless LSP plugin option for fake')
						expect(result.failure.message).toContain('initialization')
					}
				}),
			),
		))

	test('treats generated empty LSP options as having no servers', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runReferences(workspace, { filePath: 'sample.ts', offset: 6 }, {}, {})
					const payload = yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(raw)

					expect(payload.message).toContain('No LSP servers are configured')
				}),
			),
		))

	test('acknowledges supported server requests, rejects unknown requests, and ignores notifications', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const logPath = path.join(workspace, 'server-messages.log')
					const raw = yield* runReferences(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_EXERCISE_CLIENT: '1', FAKE_LSP_LOG: logPath },
					)
					const payload = yield* Schema.decodeUnknownEffect(LspReferencesResult)(raw)

					expect(payload.ok).toBe(true)
					const entries = yield* readLspLog(logPath)
					const serverMethods = entries.flatMap((entry) =>
						entry.direction === 'serverToClient' && entry.message?.method !== undefined
							? [entry.message.method]
							: [],
					)
					expect(serverMethods).toEqual(
						expect.arrayContaining([
							'workspace/configuration',
							'workspace/workspaceFolders',
							'client/registerCapability',
							'client/unregisterCapability',
							'window/workDoneProgress/create',
							'fixture/unknownRequest',
							'window/logMessage',
							'fixture/unknownNotification',
							'$/progress',
						]),
					)
					const workspaceFoldersRequest = entries.find(
						(entry) =>
							entry.direction === 'serverToClient' &&
							entry.message?.method === 'workspace/workspaceFolders',
					)?.message
					expect(workspaceFoldersRequest?.id).toBeDefined()
					const workspaceFoldersResponse = entries.find(
						(entry) =>
							entry.direction === 'clientToServer' &&
							entry.message?.id === workspaceFoldersRequest?.id &&
							entry.message?.method === undefined,
					)?.message
					expect(workspaceFoldersResponse?.result).toEqual([
						{ uri: pathToFileURL(workspace).href, name: path.basename(workspace) },
					])
				}),
			),
		))

	test('preserves the public tool name for protocol response errors', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runReferences(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_REFERENCES_ERROR: '1' },
					)
					const payload = yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(raw)

					expect(payload.tool).toBe('lsp_references')
					expect(payload.message).toContain('textDocument/references')
					expect(payload.message).toContain('forced references failure')
				}),
			),
		))

	test('runtime-decodes malformed reference results', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runReferences(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_MALFORMED_REFERENCES: '1' },
					)
					const payload = yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(raw)

					expect(payload.message).toContain('Invalid references response')
				}),
			),
		))

	test('reports malformed JSON through the protocol transport', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runReferences(
						workspace,
						{ filePath: 'sample.ts', offset: 6, timeoutMs: 1_000 },
						{},
						{
							fake: {
								command: [process.execPath, '-e', malformedMessageServer],
								extensions: ['.ts'],
							},
						},
					)
					const payload = yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(raw)

					expect(payload.message).toMatch(/LSP transport error:.*(?:JSON|Unexpected end)/u)
				}),
			),
		))

	test('document symbols preserve hierarchy', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runSymbols(workspace, { filePath: 'sample.ts' })
					const payload = yield* Schema.decodeUnknownEffect(LspSymbolsResult)(raw)

					expect(payload).toMatchObject({
						ok: true,
						mode: 'document',
						server: 'fake',
						filePath: 'sample.ts',
					})
					expect(payload.symbols).toEqual([
						expect.objectContaining({
							name: 'foo',
							kind: 12,
							filePath: 'sample.ts',
							children: [expect.objectContaining({ name: 'bar', filePath: 'sample.ts' })],
						}),
					])
				}),
			),
		))

	test('workspace symbols include container detail', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runSymbols(workspace, { query: 'foo' })
					const payload = yield* Schema.decodeUnknownEffect(LspSymbolsResult)(raw)

					expect(payload).toMatchObject({ ok: true, mode: 'workspace', query: 'foo' })
					expect(payload.symbols).toEqual([
						expect.objectContaining({
							name: 'foo',
							kind: 12,
							detail: 'fixture',
							filePath: 'sample.ts',
						}),
					])
				}),
			),
		))

	test('rename preview normalizes changes and documentChanges', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runRename(workspace, {
						filePath: 'sample.ts',
						offset: 6,
						newName: 'baz',
					})
					const payload = yield* Schema.decodeUnknownEffect(LspRenameResult)(raw)

					expect(payload).toMatchObject({
						ok: true,
						mode: 'preview',
						applied: false,
						unsupportedChanges: [],
					})
					expect(payload.edits).toHaveLength(2)
					expect(payload.edits).toEqual([
						expect.objectContaining({ filePath: 'sample.ts', newText: 'baz' }),
						expect.objectContaining({ filePath: 'sample.ts', newText: 'baz' }),
					])
				}),
			),
		))
})
