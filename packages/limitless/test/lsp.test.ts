import { watch } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Deferred, Effect, Fiber, Result, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { toolOperationError } from '../core/errors'
import {
	ToolExecutionContext,
	type ToolExecutionContext as ToolExecutionContextType,
} from '../core/execution'
import { LspCallHierarchyResult } from '../tools/lsp/call-hierarchy'
import { decodeLspConfig, LspConfig } from '../tools/lsp/config'
import { LspDefinitionResult } from '../tools/lsp/definition'
import { LspToolFailurePayload } from '../tools/lsp/errors'
import { LspHoverResult } from '../tools/lsp/hover'
import { LspReferencesInput, LspReferencesResult, lspReferences } from '../tools/lsp/references'
import { LspRenameResult } from '../tools/lsp/rename'
import { LspSymbolsResult } from '../tools/lsp/symbols'
import { lspTools } from '../tools/lsp/tools'
import { settleTestTool, testToolExecution, testToolExecutor } from './execution'

const fakeServerPath = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url))
const sampleContent = 'const foo = 1\nfoo + foo\n'

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
		Schema.Union([Schema.Literal('processExit'), Schema.Literal('ignoredSigterm')]),
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
					const methods = clientMethods(yield* readLspLog(logPath))
					expect(methods.filter((method) => method === 'initialize')).toHaveLength(1)
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

	test('hover normalizes MarkupContent and legacy MarkedString arrays', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const markupRaw = yield* runHover(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{ FAKE_LSP_HOVER_MODE: 'markup-markdown' },
					)
					const markup = yield* Schema.decodeUnknownEffect(LspHoverResult)(markupRaw)
					expect(markup.hover).toEqual({
						contents: [{ kind: 'markdown', value: '**foo** docs' }],
						range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
					})

					const legacyRaw = yield* runHover(workspace, { filePath: 'sample.ts', offset: 6 })
					const legacy = yield* Schema.decodeUnknownEffect(LspHoverResult)(legacyRaw)
					expect(legacy.hover?.contents).toEqual([
						{ kind: 'markdown', value: '**legacy foo**' },
						{ kind: 'code', language: 'typescript', value: 'const foo: number' },
					])
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

	test('references return workspace-relative locations with source text and honor maxResults', () =>
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
					expect(payload.locations.length).toBeGreaterThan(1)
					for (const location of payload.locations) {
						expect(location).toMatchObject({ filePath: 'sample.ts', text: 'foo' })
					}

					const limitedRaw = yield* runReferences(workspace, {
						filePath: 'sample.ts',
						offset: 6,
						maxResults: 1,
					})
					const limited = yield* Schema.decodeUnknownEffect(LspReferencesResult)(limitedRaw)
					expect(limited.locations).toHaveLength(1)
					expect(limited.truncated).toBe(true)
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
