import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
	ScratchpadCreateInput,
	type ScratchpadCreateResult,
	ScratchpadListInput,
	type ScratchpadListResult,
	scratchpadCreate,
	scratchpadFilePath,
	scratchpadList,
	scratchpadRelativePath,
	scratchpadRoot,
	validateScratchpadName,
} from '../packages/limitless/scratchpad'
import { executeTool } from '../packages/limitless/shared'

type ScratchpadContext = Parameters<typeof scratchpadCreate>[1]

function context(worktree: string, sessionID = 'session'): ScratchpadContext {
	return {
		sessionID,
		messageID: 'message',
		agent: 'limitless',
		directory: worktree,
		worktree,
		abort: new AbortController().signal,
		metadata: () => undefined,
		ask: () => {
			throw new Error('ask is not used by scratchpad tests.')
		},
	}
}

async function withWorkspace<T>(body: (workspace: string) => Promise<T>): Promise<T> {
	const workspace = await mkdtemp(path.join(os.tmpdir(), 'limitless-scratchpad-'))
	try {
		return await body(workspace)
	} finally {
		await rm(workspace, { recursive: true, force: true })
	}
}

function parseToolOutput<T>(result: Awaited<ReturnType<typeof executeTool>>): T {
	return JSON.parse(typeof result === 'string' ? result : result.output) as T
}

async function runScratchpadCreate(
	input: { readonly name: string },
	ctx: ScratchpadContext,
): Promise<ScratchpadCreateResult> {
	const result = await executeTool('scratchpad_create', ScratchpadCreateInput, input, ctx, (args) =>
		scratchpadCreate(args, ctx),
	)
	return parseToolOutput<ScratchpadCreateResult>(result)
}

async function runScratchpadCreatePayload(
	input: { readonly name: string },
	ctx: ScratchpadContext,
): Promise<unknown> {
	const result = await executeTool('scratchpad_create', ScratchpadCreateInput, input, ctx, (args) =>
		scratchpadCreate(args, ctx),
	)
	return parseToolOutput<unknown>(result)
}

async function runScratchpadList(ctx: ScratchpadContext): Promise<ScratchpadListResult> {
	const result = await executeTool('scratchpad_list', ScratchpadListInput, {}, ctx, (args) =>
		scratchpadList(args, ctx),
	)
	return parseToolOutput<ScratchpadListResult>(result)
}

describe('scratchpad name validation', () => {
	test('accepts flat file names', () => {
		expect(validateScratchpadName('plan.md')).toBeUndefined()
		expect(validateScratchpadName('debug-notes.txt')).toBeUndefined()
		expect(validateScratchpadName('state_1.json')).toBeUndefined()
	})

	test('rejects path-like names', () => {
		for (const name of ['', '.', '..', '../secret', 'foo/bar', 'foo\\bar', 'space name.md']) {
			expect(validateScratchpadName(name), name).toBeDefined()
		}
	})
})

describe('scratchpad paths', () => {
	test('uses workspace-relative paths for tool results', () => {
		expect(scratchpadRelativePath('session', 'plan.md')).toBe('.limitless/session/plan.md')
		expect(scratchpadRoot('/repo', 'session')).toBe(path.resolve('/repo/.limitless/session'))
		expect(scratchpadFilePath('/repo', 'session', 'plan.md')).toBe(
			path.resolve('/repo/.limitless/session/plan.md'),
		)
	})

	test('encodes session IDs so they remain a single path segment', () => {
		expect(scratchpadRelativePath('a/b', 'plan.md')).toBe('.limitless/a%2Fb/plan.md')
	})
})

describe('scratchpad create and list', () => {
	test('creates an empty file without overwriting existing content', async () => {
		await withWorkspace(async (workspace) => {
			const ctx = context(workspace)
			const first = await runScratchpadCreate({ name: 'plan.md' }, ctx)
			expect(first).toMatchObject({
				ok: true,
				name: 'plan.md',
				path: '.limitless/session/plan.md',
				created: true,
			})
			expect(await readFile(scratchpadFilePath(workspace, 'session', 'plan.md'), 'utf8')).toBe('')

			await writeFile(scratchpadFilePath(workspace, 'session', 'plan.md'), 'notes')
			const second = await runScratchpadCreate({ name: 'plan.md' }, ctx)
			expect(second.created).toBe(false)
			expect(await readFile(scratchpadFilePath(workspace, 'session', 'plan.md'), 'utf8')).toBe(
				'notes',
			)

			const list = await runScratchpadList(ctx)
			expect(list.files).toHaveLength(1)
			expect(list.files[0]).toMatchObject({
				name: 'plan.md',
				path: '.limitless/session/plan.md',
				sizeBytes: 5,
			})
			expect(list.files[0]?.updatedAt).toEqual(expect.any(String))
		})
	})

	test('lists an empty scratchpad before any files are created', async () => {
		await withWorkspace(async (workspace) => {
			await expect(runScratchpadList(context(workspace))).resolves.toEqual({
				ok: true,
				files: [],
			})
		})
	})

	test('rejects existing symlinks', async () => {
		await withWorkspace(async (workspace) => {
			const target = path.join(workspace, 'outside.txt')
			await writeFile(target, 'secret')
			await mkdir(scratchpadRoot(workspace, 'session'), { recursive: true })
			await symlink(target, scratchpadFilePath(workspace, 'session', 'link.md'))

			const result = await runScratchpadCreatePayload({ name: 'link.md' }, context(workspace))
			expect(result).toMatchObject({
				ok: false,
				error: 'ToolInputError',
				tool: 'scratchpad_create',
			})
			expect(JSON.stringify(result)).not.toContain(workspace)
		})
	})

	test('rejects symlink scratchpad directories', async () => {
		await withWorkspace(async (workspace) => {
			const outside = path.join(workspace, 'outside')
			await mkdir(outside)
			await symlink(outside, path.join(workspace, '.limitless'))

			const result = await runScratchpadCreatePayload({ name: 'plan.md' }, context(workspace))
			expect(result).toMatchObject({
				ok: false,
				error: 'ToolInputError',
				tool: 'scratchpad_create',
			})
			expect(JSON.stringify(result)).not.toContain(workspace)
		})
	})
})
