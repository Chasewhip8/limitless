import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginInput, ToolContext } from '@opencode-ai/plugin'
import { describe, expect, test } from 'vitest'
import { LspReferencesInput, LspRenameInput, LspSymbolsInput } from '../lib/lsp'
import { lspReferences, lspRename, lspSymbols } from '../lsp'
import { executeTool } from '../shared'

const fakeServerPath = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url))
const sampleContent = 'const foo = 1\nfoo + foo\n'

type LspPayload = Record<string, unknown>

function context(worktree: string): ToolContext {
	return {
		sessionID: 'session',
		messageID: 'message',
		agent: 'limitless',
		directory: worktree,
		worktree,
		abort: new AbortController().signal,
		metadata: () => undefined,
		ask: () => {
			throw new Error('ask is not used by LSP tests.')
		},
	}
}

function pluginInput(env: Record<string, string> = {}): PluginInput {
	const input = {
		client: {
			config: {
				get: async () => ({
					data: {
						lsp: {
							fake: {
								command: [process.execPath, fakeServerPath],
								extensions: ['.ts'],
								env,
							},
						},
					},
				}),
			},
		},
	}
	// The SDK client surface is broad; these tests only need client.config.get.
	return input as unknown as PluginInput
}

function parseToolOutput(result: Awaited<ReturnType<typeof executeTool>>): LspPayload {
	return JSON.parse(typeof result === 'string' ? result : result.output) as LspPayload
}

async function withWorkspace<T>(body: (workspace: string) => Promise<T>): Promise<T> {
	const workspace = await mkdtemp(path.join(os.tmpdir(), 'limitless-lsp-'))
	try {
		await writeFile(path.join(workspace, 'sample.ts'), sampleContent)
		await writeFile(path.join(workspace, 'sample.py'), sampleContent)
		return await body(workspace)
	} finally {
		await rm(workspace, { recursive: true, force: true })
	}
}

async function runReferences(
	workspace: string,
	input: unknown,
	env: Record<string, string> = {},
): Promise<LspPayload> {
	const ctx = context(workspace)
	const result = await executeTool('lsp_references', LspReferencesInput, input, ctx, (args) =>
		lspReferences(pluginInput(env), args, ctx),
	)
	return parseToolOutput(result)
}

async function runSymbols(
	workspace: string,
	input: unknown,
	env: Record<string, string> = {},
): Promise<LspPayload> {
	const ctx = context(workspace)
	const result = await executeTool('lsp_symbols', LspSymbolsInput, input, ctx, (args) =>
		lspSymbols(pluginInput(env), args, ctx),
	)
	return parseToolOutput(result)
}

async function runRename(
	workspace: string,
	input: unknown,
	env: Record<string, string> = {},
): Promise<LspPayload> {
	const ctx = context(workspace)
	const result = await executeTool('lsp_rename', LspRenameInput, input, ctx, (args) =>
		lspRename(pluginInput(env), args, ctx),
	)
	return parseToolOutput(result)
}

describe('LSP tools', () => {
	test('references return workspace-relative locations with source text', async () => {
		await withWorkspace(async (workspace) => {
			const payload = await runReferences(workspace, { filePath: 'sample.ts', offset: 6 })

			expect(payload).toMatchObject({
				ok: true,
				server: 'fake',
				filePath: 'sample.ts',
				truncated: false,
			})
			const locations = payload.locations as Array<Record<string, unknown>>
			expect(locations.length).toBeGreaterThan(0)
			for (const location of locations) {
				expect(location.filePath).toBe('sample.ts')
				expect(location.range).toMatchObject({
					start: expect.objectContaining({
						line: expect.any(Number),
						character: expect.any(Number),
					}),
					end: expect.objectContaining({ line: expect.any(Number), character: expect.any(Number) }),
				})
			}
			expect(locations[0]).toMatchObject({ text: 'foo' })
		})
	})

	test('references respect maxResults', async () => {
		await withWorkspace(async (workspace) => {
			const payload = await runReferences(workspace, {
				filePath: 'sample.ts',
				offset: 6,
				maxResults: 1,
			})

			expect(payload.ok).toBe(true)
			expect(payload.locations).toHaveLength(1)
			expect(payload.truncated).toBe(true)
		})
	})

	test('references reject offsets outside the file', async () => {
		await withWorkspace(async (workspace) => {
			const payload = await runReferences(workspace, { filePath: 'sample.ts', offset: 9_999 })

			expect(payload).toMatchObject({ ok: false, error: 'LspToolError' })
			expect(payload.message).toEqual(expect.stringContaining('Offset'))
		})
	})

	test('references require a matching server extension', async () => {
		await withWorkspace(async (workspace) => {
			const payload = await runReferences(workspace, { filePath: 'sample.py', offset: 6 })

			expect(payload).toMatchObject({ ok: false, error: 'LspToolError' })
			expect(payload.message).toEqual(expect.stringContaining('No configured LSP server matches'))
		})
	})

	test('references require the server capability', async () => {
		await withWorkspace(async (workspace) => {
			const payload = await runReferences(
				workspace,
				{ filePath: 'sample.ts', offset: 6 },
				{ FAKE_LSP_NO_REFERENCES_CAPABILITY: '1' },
			)

			expect(payload).toMatchObject({ ok: false, error: 'LspToolError' })
			expect(payload.message).toEqual(expect.stringContaining('referencesProvider'))
		})
	})

	test('references report request timeouts', async () => {
		await withWorkspace(async (workspace) => {
			const payload = await runReferences(
				workspace,
				{ filePath: 'sample.ts', offset: 6, timeoutMs: 300 },
				{ FAKE_LSP_DELAY_MS: '5000' },
			)

			expect(payload).toMatchObject({ ok: false, error: 'LspToolError' })
			expect(payload.message).toEqual(expect.stringContaining('timed out'))
		})
	})

	test('references report servers that exit early', async () => {
		await withWorkspace(async (workspace) => {
			const payload = await runReferences(
				workspace,
				{ filePath: 'sample.ts', offset: 6 },
				{ FAKE_LSP_EXIT_EARLY: '1' },
			)

			expect(payload).toMatchObject({ ok: false, error: 'LspToolError' })
			expect(payload.message).toMatch(/exited|closed/iu)
		})
	})

	test('document symbols preserve hierarchy', async () => {
		await withWorkspace(async (workspace) => {
			const payload = await runSymbols(workspace, { filePath: 'sample.ts' })

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
		})
	})

	test('workspace symbols include container detail', async () => {
		await withWorkspace(async (workspace) => {
			const payload = await runSymbols(workspace, { filePath: 'sample.ts', query: 'foo' })

			expect(payload).toMatchObject({ ok: true, mode: 'workspace', query: 'foo' })
			expect(payload.symbols).toEqual([
				expect.objectContaining({
					name: 'foo',
					kind: 12,
					detail: 'fixture',
					filePath: 'sample.ts',
				}),
			])
		})
	})

	test('rename preview normalizes changes and documentChanges', async () => {
		await withWorkspace(async (workspace) => {
			const payload = await runRename(workspace, {
				filePath: 'sample.ts',
				offset: 6,
				newName: 'baz',
			})

			expect(payload).toMatchObject({
				ok: true,
				mode: 'preview',
				applied: false,
				unsupportedChanges: [],
			})
			const edits = payload.edits as Array<Record<string, unknown>>
			expect(edits).toHaveLength(2)
			expect(edits).toEqual([
				expect.objectContaining({ filePath: 'sample.ts', newText: 'baz' }),
				expect.objectContaining({ filePath: 'sample.ts', newText: 'baz' }),
			])
		})
	})
})
