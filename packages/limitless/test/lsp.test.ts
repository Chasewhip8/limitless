import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginInput, ToolContext } from '@opencode-ai/plugin'
import { Effect, Result, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { toolOperationError } from '../core/errors'
import { executeTool } from '../core/tool-boundary'
import { LspToolFailurePayload, lspToolFailureEncoder } from '../tools/lsp/errors'
import { LspReferencesInput, LspReferencesResult, lspReferences } from '../tools/lsp/references'
import { LspRenameInput, LspRenameResult, lspRename } from '../tools/lsp/rename'
import { LspSymbolsInput, LspSymbolsResult, lspSymbols } from '../tools/lsp/symbols'

const fakeServerPath = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url))
const sampleContent = 'const foo = 1\nfoo + foo\n'
const malformedMessageServer = [
	'const body = \'{"jsonrpc":"2.0","id":1,"result":\'',
	"process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\\r\\n\\r\\n' + body)",
	'process.stdin.resume()',
].join(';')

function context(worktree: string, abort: AbortSignal = new AbortController().signal): ToolContext {
	return {
		sessionID: 'session',
		messageID: 'message',
		agent: 'limitless',
		directory: worktree,
		worktree,
		abort,
		metadata: () => undefined,
		ask: () => {
			throw new Error('ask is not used by LSP tests.')
		},
	}
}

function pluginInput(
	env: Record<string, string> = {},
	lsp: unknown = {
		fake: {
			command: [process.execPath, fakeServerPath],
			extensions: ['.ts'],
			env,
		},
	},
): PluginInput {
	const input = {
		client: {
			config: {
				get: () => Promise.resolve({ data: { lsp } }),
			},
		},
	}
	// The SDK client surface is broad; this operational fixture only implements config.get.
	return input as unknown as PluginInput
}

function testPromise<T>(evaluate: () => Promise<T>) {
	return Effect.tryPromise({
		try: evaluate,
		catch: (error) => toolOperationError('lsp_test', 'Test operation failed', error),
	})
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

function decodeToolResult(result: Awaited<ReturnType<typeof executeTool>>) {
	return Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
		typeof result === 'string' ? result : result.output,
	)
}

function runReferences(
	workspace: string,
	input: unknown,
	env: Record<string, string> = {},
	lsp?: unknown,
) {
	const ctx = context(workspace)
	return testPromise(() =>
		executeTool(
			'lsp_references',
			LspReferencesInput,
			LspReferencesResult,
			input,
			ctx,
			(args) => lspReferences(pluginInput(env, lsp), args, ctx),
			lspToolFailureEncoder,
		),
	).pipe(Effect.flatMap(decodeToolResult))
}

function runSymbols(workspace: string, input: unknown, env: Record<string, string> = {}) {
	const ctx = context(workspace)
	return testPromise(() =>
		executeTool(
			'lsp_symbols',
			LspSymbolsInput,
			LspSymbolsResult,
			input,
			ctx,
			(args) => lspSymbols(pluginInput(env), args, ctx),
			lspToolFailureEncoder,
		),
	).pipe(Effect.flatMap(decodeToolResult))
}

function runRename(workspace: string, input: unknown, env: Record<string, string> = {}) {
	const ctx = context(workspace)
	return testPromise(() =>
		executeTool(
			'lsp_rename',
			LspRenameInput,
			LspRenameResult,
			input,
			ctx,
			(args) => lspRename(pluginInput(env), args, ctx),
			lspToolFailureEncoder,
		),
	).pipe(Effect.flatMap(decodeToolResult))
}

describe('LSP tools', () => {
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
					const raw = yield* runReferences(
						workspace,
						{ filePath: 'sample.ts', offset: 6, timeoutMs: 300 },
						{ FAKE_LSP_DELAY_MS: '5000' },
					)
					const payload = yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(raw)

					expect(payload.message).toEqual(expect.stringContaining('timed out'))
				}),
			),
		))

	test('cancellation interrupts scoped server work', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const controller = new AbortController()
					const ctx = context(workspace, controller.signal)
					yield* Effect.sleep(50).pipe(
						Effect.andThen(Effect.sync(() => controller.abort())),
						Effect.forkChild({ startImmediately: true }),
					)
					const result = yield* Effect.result(
						lspReferences(
							pluginInput({ FAKE_LSP_DELAY_MS: '5000' }),
							LspReferencesInput.make({ filePath: 'sample.ts', offset: 6 }),
							ctx,
						),
					)

					expect(Result.isFailure(result)).toBe(true)
					if (Result.isFailure(result)) expect(result.failure.message).toContain('cancelled')
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

	test('rejects malformed configured server fields with server context', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runReferences(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{},
						{
							fake: {
								command: [process.execPath, fakeServerPath],
								extensions: ['.ts'],
								initialization: 42,
							},
						},
					)
					const payload = yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(raw)

					expect(payload.server).toBe('fake')
					expect(payload.message).toEqual(
						expect.stringContaining('Invalid OpenCode LSP configuration'),
					)
				}),
			),
		))

	test('treats a disabled global LSP config as having no servers', () =>
		Effect.runPromise(
			withWorkspace((workspace) =>
				Effect.gen(function* () {
					const raw = yield* runReferences(
						workspace,
						{ filePath: 'sample.ts', offset: 6 },
						{},
						false,
					)
					const payload = yield* Schema.decodeUnknownEffect(LspToolFailurePayload)(raw)

					expect(payload.message).toContain('No LSP servers are configured')
				}),
			),
		))

	test('reports malformed JSON-RPC messages', () =>
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

					expect(payload.message).toEqual(expect.stringContaining('malformed JSON-RPC'))
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
