import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Deferred, Effect, Schema } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ToolExecutionContext } from '../core/execution'
import { ArtifactCreateResult } from '../tools/artifacts/create'
import { ArtifactListResult, artifactSlugFromString } from '../tools/artifacts/list'
import {
	artifactDirectoryPath,
	artifactRelativePath,
	artifactsRoot,
} from '../tools/artifacts/paths'
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

describe('artifact tools', () => {
	test('exposes creation and listing', () => {
		expect(Object.keys(artifactTools(testToolExecutor(context('/repo')))).sort()).toEqual([
			'artifact_create',
			'artifact_list',
		])
	})
})

describe('artifact slug validation', () => {
	test('accepts durable artifact slugs', () => {
		expect(artifactSlugFromString('2026-06-29-a3f91c-strategy-notes')).toBeDefined()
		expect(artifactSlugFromString('notes_1')).toBeDefined()
		expect(artifactSlugFromString('A.B-C_1')).toBeDefined()
	})

	test('rejects path-like slugs', () => {
		for (const slug of ['', '.', '..', '../secret', 'foo/bar', 'foo\\bar', 'space name']) {
			expect(artifactSlugFromString(slug), slug).toBeUndefined()
		}
	})
})

describe('artifact paths', () => {
	test('uses project-scoped workspace-relative paths', () => {
		const slug = artifactSlugFromString('strategy-notes')
		if (slug === undefined) throw new Error('expected a valid artifact slug')
		expect(artifactRelativePath(slug)).toBe('.limitless/artifacts/strategy-notes')
		expect(artifactsRoot('/repo')).toBe(path.resolve('/repo/.limitless/artifacts'))
		expect(artifactDirectoryPath('/repo', slug)).toBe(
			path.resolve('/repo/.limitless/artifacts/strategy-notes'),
		)
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

	test('generates slugs from trimmed titles', async () => {
		await withWorkspace(async (workspace) => {
			const created = await runArtifactCreate({ title: '  Pricing Notes!  ' }, context(workspace))
			expect(created.artifact.slug).toMatch(/^\d{4}-\d{2}-\d{2}-[a-f0-9]{6}-pricing-notes$/u)
			expect(created.artifact.title).toBe('Pricing Notes!')
		})
	})

	test('creates an untitled artifact when no title or slug is supplied', async () => {
		await withWorkspace(async (workspace) => {
			const created = await runArtifactCreate({}, context(workspace))
			expect(created.artifact.slug).toMatch(/^\d{4}-\d{2}-\d{2}-[a-f0-9]{6}-artifact$/u)
			expect(created.artifact).not.toHaveProperty('title')
		})
	})

	test('lists existing artifacts with additional manifest metadata without changing files', async () => {
		await withWorkspace(async (workspace) => {
			const directory = path.join(workspace, '.limitless/artifacts/existing-notes')
			await mkdir(directory, { recursive: true })
			const manifest = {
				slug: 'existing-notes',
				createdAt: '2026-06-29T12:00:00.000Z',
				title: 'Existing notes',
				template: 'brief',
			}
			const manifestText = JSON.stringify(manifest)
			await writeFile(path.join(directory, 'manifest.json'), manifestText)
			await writeFile(path.join(directory, 'scratchpad.md'), '# Existing notes\n')

			const list = await runArtifactList(context(workspace))
			expect(list.artifacts).toEqual([
				{
					slug: manifest.slug,
					createdAt: manifest.createdAt,
					title: manifest.title,
					path: '.limitless/artifacts/existing-notes',
				},
			])
			await expect(readFile(path.join(directory, 'manifest.json'), 'utf8')).resolves.toBe(
				manifestText,
			)
			await expect(readFile(path.join(directory, 'scratchpad.md'), 'utf8')).resolves.toBe(
				'# Existing notes\n',
			)
		})
	})

	test('lists an empty artifact root before any artifacts are created', async () => {
		await withWorkspace(async (workspace) => {
			await expect(runArtifactList(context(workspace))).resolves.toEqual({
				ok: true,
				artifacts: [],
			})
			expect(await readdir(workspace)).toEqual([])
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

	test('rejects existing artifact workspaces instead of reusing them', async () => {
		await withWorkspace(async (workspace) => {
			const ctx = context(workspace)
			const created = await runArtifactCreate({ slug: 'notes' }, ctx)
			const manifestPath = path.join(workspace, created.artifact.path, 'manifest.json')
			const manifest = await readFile(manifestPath, 'utf8')

			const result = await runArtifactTool('artifact_create', { slug: 'notes' }, ctx)
			expect(result).toMatchObject({
				ok: false,
				error: 'ToolInputError',
				tool: 'artifact_create',
				message: 'Artifact already exists: notes',
			})
			expect(JSON.stringify(result)).not.toContain(workspace)
			await expect(readFile(manifestPath, 'utf8')).resolves.toBe(manifest)
		})
	})

	test('removes an incomplete directory when the manifest cannot be opened', async () => {
		await withWorkspace(async (workspace) => {
			vi.spyOn(fs, 'open').mockRejectedValueOnce(
				Object.assign(new Error('write unavailable'), { code: 'EIO' }),
			)
			const ctx = context(workspace)
			const result = await runArtifactTool('artifact_create', { slug: 'notes' }, ctx)
			expect(result).toMatchObject({ ok: false, error: 'ToolOperationError', code: 'EIO' })
			expect(await readdir(artifactsRoot(workspace))).toEqual([])
			const retried = await runArtifactCreate({ slug: 'notes' }, ctx)
			expect(retried.artifact.slug).toBe('notes')
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

	test('removes an incomplete artifact when closing the manifest fails', async () => {
		await withWorkspace(async (workspace) => {
			const open = fs.open
			vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
				const handle = await open(...args)
				const close = handle.close.bind(handle)
				vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
					await close()
					throw Object.assign(new Error('close failed'), { code: 'EIO' })
				})
				return handle
			})
			const result = await runArtifactTool('artifact_create', { slug: 'notes' }, context(workspace))
			expect(result).toMatchObject({
				ok: false,
				error: 'ToolOperationError',
				message: 'Could not close artifact file (EIO)',
			})
			expect(await readdir(artifactsRoot(workspace))).toEqual([])
		})
	})

	test('preserves concurrent files and reports incomplete cleanup', async () => {
		await withWorkspace(async (workspace) => {
			const scratchpadPath = path.join(artifactsRoot(workspace), 'notes', 'scratchpad.md')
			vi.spyOn(fs, 'open').mockImplementationOnce(async () => {
				await writeFile(scratchpadPath, '# Concurrent notes\n')
				throw Object.assign(new Error('write unavailable'), { code: 'EIO' })
			})
			const result = await runArtifactTool('artifact_create', { slug: 'notes' }, context(workspace))
			expect(result).toMatchObject({
				ok: false,
				error: 'ToolOperationError',
				message: 'Could not remove incomplete artifact: notes (ENOTEMPTY)',
			})
			await expect(readFile(scratchpadPath, 'utf8')).resolves.toBe('# Concurrent notes\n')
		})
	})

	test('reports incomplete cleanup when a partial manifest cannot be removed', async () => {
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
			vi.spyOn(fs, 'unlink').mockRejectedValueOnce(
				Object.assign(new Error('cleanup unavailable'), { code: 'EACCES' }),
			)
			const result = await runArtifactTool('artifact_create', { slug: 'notes' }, context(workspace))
			expect(result).toMatchObject({
				ok: false,
				error: 'ToolOperationError',
				message: 'Could not remove incomplete artifact: notes (ENOTEMPTY)',
			})
			expect((await runArtifactList(context(workspace))).invalidArtifacts).toEqual([
				{ slug: 'notes', reason: 'manifest.json is missing or invalid' },
			])
		})
	})

	test('finishes an in-flight manifest write before cancellation releases the directory', async () => {
		await withWorkspace(async (workspace) => {
			const writeStarted = Deferred.makeUnsafe<void>()
			const finishWrite = Deferred.makeUnsafe<void>()
			const open = fs.open
			vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
				const handle = await open(...args)
				const write = handle.writeFile.bind(handle)
				vi.spyOn(handle, 'writeFile').mockImplementationOnce(async (...writeArgs) => {
					await Effect.runPromise(Deferred.succeed(writeStarted, undefined))
					await Effect.runPromise(Deferred.await(finishWrite))
					return write(...writeArgs)
				})
				return handle
			})
			const ctx = context(workspace)
			const controller = new AbortController()
			const tool = artifactTools(testToolExecutor(ctx)).artifact_create
			const creation = Effect.runPromise(settleTestTool(tool, { slug: 'notes' }, ctx), {
				signal: controller.signal,
			})
			const cancelled = expect(creation).rejects.toBeDefined()
			await Effect.runPromise(Deferred.await(writeStarted))
			controller.abort()
			await Effect.runPromise(Deferred.succeed(finishWrite, undefined))
			await cancelled
			const list = await runArtifactList(ctx)
			expect(list.artifacts.map((artifact) => artifact.slug)).toEqual(['notes'])
			expect(list.invalidArtifacts).toBeUndefined()
		})
	})

	test('preserves an existing manifest that appears before the exclusive file open', async () => {
		await withWorkspace(async (workspace) => {
			const open = fs.open
			const manifestPath = path.join(artifactsRoot(workspace), 'notes', 'manifest.json')
			vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
				await writeFile(manifestPath, 'concurrent manifest')
				return open(...args)
			})
			const result = await runArtifactTool('artifact_create', { slug: 'notes' }, context(workspace))
			expect(result).toMatchObject({ ok: false, error: 'ToolOperationError' })
			await expect(readFile(manifestPath, 'utf8')).resolves.toBe('concurrent manifest')
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
