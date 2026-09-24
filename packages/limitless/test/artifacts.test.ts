import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Effect, Schema } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ToolExecutionContext } from '../core/execution'
import { ArtifactCreateResult } from '../tools/artifacts/create'
import { ArtifactListResult, artifactSlugFromString } from '../tools/artifacts/list'
import { artifactsRoot } from '../tools/artifacts/paths'
import { artifactTools } from '../tools/artifacts/tools'
import { settleTestTool, testToolExecution, testToolExecutor } from './execution'

vi.mock('node:fs/promises', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:fs/promises')>()),
}))

afterEach(() => {
	vi.restoreAllMocks()
})

function context(worktree: string, sessionID = 'session'): ToolExecutionContext {
	return testToolExecution(worktree, sessionID)
}

async function withWorkspace<T>(body: (workspace: string) => Promise<T>): Promise<T> {
	const workspace = await mkdtemp(path.join(os.tmpdir(), 'limitless-artifacts-'))
	try {
		return await body(workspace)
	} finally {
		await rm(workspace, { recursive: true, force: true })
	}
}

function runArtifactTool(
	name: keyof ReturnType<typeof artifactTools>,
	input: unknown,
	ctx: ToolExecutionContext,
) {
	const definition = artifactTools(testToolExecutor(ctx))[name]
	return Effect.runPromise(
		settleTestTool(definition, input, ctx).pipe(
			Effect.match({
				onFailure: (failure) =>
					failure.metadata ?? { error: failure._tag, message: failure.message },
				onSuccess: (result) => result.output,
			}),
		),
	)
}

async function runArtifactCreate(
	input: { readonly title?: string; readonly slug?: string },
	ctx: ToolExecutionContext,
): Promise<ArtifactCreateResult> {
	return Effect.runPromise(
		Schema.decodeUnknownEffect(ArtifactCreateResult)(
			await runArtifactTool('artifact_create', input, ctx),
		),
	)
}

async function runArtifactList(ctx: ToolExecutionContext): Promise<ArtifactListResult> {
	return Effect.runPromise(
		Schema.decodeUnknownEffect(ArtifactListResult)(await runArtifactTool('artifact_list', {}, ctx)),
	)
}

describe('artifact slug validation', () => {
	test('rejects path-like slugs', () => {
		for (const slug of ['', '.', '..', '../secret', 'foo/bar', 'foo\\bar', 'space name']) {
			expect(artifactSlugFromString(slug), slug).toBeUndefined()
		}
	})
})

describe('artifact create and list', () => {
	test('creates an empty artifact without session path scoping', async () => {
		await withWorkspace(async (workspace) => {
			const response = await runArtifactTool(
				'artifact_create',
				{ title: 'Pricing notes', slug: 'pricing-notes' },
				context(workspace, 'session-a'),
			)
			const created = Schema.decodeUnknownSync(ArtifactCreateResult)(response)

			expect(response).toEqual({
				ok: true,
				artifact: {
					slug: 'pricing-notes',
					path: '.limitless/artifacts/pricing-notes',
					title: 'Pricing notes',
					createdAt: expect.any(String),
				},
			})
			expect(created.artifact.path).not.toContain('session-a')
			const directory = path.join(workspace, created.artifact.path)
			expect((await readdir(directory)).sort()).toEqual(['manifest.json'])

			const manifest = JSON.parse(
				await readFile(path.join(directory, 'manifest.json'), 'utf8'),
			) as Record<string, unknown>
			expect(manifest).toEqual({
				slug: 'pricing-notes',
				title: 'Pricing notes',
				createdAt: expect.any(String),
				createdBy: { sessionID: 'session-a', agent: 'limitless' },
			})

			const scratchpadPath = path.join(directory, 'scratchpad.md')
			await writeFile(scratchpadPath, '# Pricing notes\n\nCompare usage tiers.\n')
			const list = await runArtifactList(context(workspace, 'session-b'))
			expect(list.artifacts).toEqual([created.artifact])
			await expect(readFile(scratchpadPath, 'utf8')).resolves.toBe(
				'# Pricing notes\n\nCompare usage tiers.\n',
			)
		})
	})

	test('reports missing and invalid manifests while listing valid artifacts', async () => {
		await withWorkspace(async (workspace) => {
			const ctx = context(workspace)
			await runArtifactCreate({ slug: 'valid' }, ctx)
			const root = artifactsRoot(workspace)
			await mkdir(path.join(root, 'missing'))
			await mkdir(path.join(root, 'invalid'))
			await writeFile(path.join(root, 'invalid', 'manifest.json'), '{}')
			const list = await runArtifactList(ctx)
			expect(list.artifacts.map((entry) => entry.slug)).toEqual(['valid'])
			expect(list.invalidArtifacts).toHaveLength(2)
			expect(list.invalidArtifacts).toEqual(
				expect.arrayContaining([
					{ slug: 'missing', reason: 'manifest.json is missing or invalid' },
					{ slug: 'invalid', reason: 'manifest.json is missing or invalid' },
				]),
			)
		})
	})

	test('removes a partially written manifest and allows the same slug to be retried', async () => {
		await withWorkspace(async (workspace) => {
			const open = fs.open
			vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
				const handle = await open(...args)
				await handle.writeFile('{')
				vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(
					Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
				)
				return handle
			})
			const ctx = context(workspace)
			const result = await runArtifactTool('artifact_create', { slug: 'notes' }, ctx)
			expect(result).toMatchObject({ ok: false, error: 'ToolOperationError', code: 'ENOSPC' })
			expect(await readdir(artifactsRoot(workspace))).toEqual([])
			const retried = await runArtifactCreate({ slug: 'notes' }, ctx)
			expect(retried.artifact.slug).toBe('notes')
		})
	})

	test('creates only one artifact when callers request the same slug concurrently', async () => {
		await withWorkspace(async (workspace) => {
			const ctx = context(workspace)
			const results = await Promise.all([
				runArtifactTool('artifact_create', { slug: 'notes' }, ctx),
				runArtifactTool('artifact_create', { slug: 'notes' }, ctx),
			])
			expect(results).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						ok: true,
						artifact: expect.objectContaining({ slug: 'notes' }),
					}),
					expect.objectContaining({
						ok: false,
						error: 'ToolInputError',
						message: 'Artifact already exists: notes',
					}),
				]),
			)
			expect((await runArtifactList(ctx)).artifacts).toHaveLength(1)
		})
	})

	test('rejects symlink artifact roots', async () => {
		await withWorkspace(async (workspace) => {
			const outside = path.join(workspace, 'outside')
			await mkdir(outside)
			await symlink(outside, path.join(workspace, '.limitless'))

			const result = await runArtifactTool('artifact_create', { slug: 'plan' }, context(workspace))
			expect(result).toMatchObject({
				ok: false,
				error: 'ToolOperationError',
				tool: 'artifact_create',
			})
			expect(JSON.stringify(result)).not.toContain(workspace)
		})
	})
})
