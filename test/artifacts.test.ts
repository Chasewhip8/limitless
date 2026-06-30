import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
	ArtifactCreateInput,
	type ArtifactCreateResult,
	ArtifactListInput,
	type ArtifactListResult,
	artifactCreate,
	artifactDirectoryPath,
	artifactList,
	artifactRelativePath,
	artifactSlugFromString,
	artifactsRoot,
	decodeArtifactSlugSync,
	TypstCompileInput,
	type TypstCompileResult,
	TypstTemplatesListInput,
	type TypstTemplatesListResult,
	typstCompile,
	typstTemplatesList,
} from '../packages/limitless/artifacts'
import { executeTool } from '../packages/limitless/shared'

type ArtifactContext = Parameters<typeof artifactCreate>[1]

function context(worktree: string, sessionID = 'session'): ArtifactContext {
	return {
		sessionID,
		messageID: 'message',
		agent: 'limitless',
		directory: worktree,
		worktree,
		abort: new AbortController().signal,
		metadata: () => undefined,
		ask: () => {
			throw new Error('ask is not used by artifact tests.')
		},
	}
}

async function withWorkspace<T>(body: (workspace: string) => Promise<T>): Promise<T> {
	const workspace = await mkdtemp(path.join(os.tmpdir(), 'limitless-artifacts-'))
	try {
		return await body(workspace)
	} finally {
		await rm(workspace, { recursive: true, force: true })
	}
}

function parseToolOutput<T>(result: Awaited<ReturnType<typeof executeTool>>): T {
	return JSON.parse(typeof result === 'string' ? result : result.output) as T
}

async function runArtifactCreate(
	input: {
		readonly kind?: string
		readonly title?: string
		readonly slug?: string
		readonly template?: string
	},
	ctx: ArtifactContext,
): Promise<ArtifactCreateResult> {
	const result = await executeTool('artifact_create', ArtifactCreateInput, input, ctx, (args) =>
		artifactCreate(args, ctx),
	)
	return parseToolOutput<ArtifactCreateResult>(result)
}

async function runArtifactCreatePayload(
	input: {
		readonly kind?: string
		readonly title?: string
		readonly slug?: string
		readonly template?: string
	},
	ctx: ArtifactContext,
): Promise<unknown> {
	const result = await executeTool('artifact_create', ArtifactCreateInput, input, ctx, (args) =>
		artifactCreate(args, ctx),
	)
	return parseToolOutput<unknown>(result)
}

async function runArtifactList(
	input: { readonly kind?: string; readonly template?: string },
	ctx: ArtifactContext,
): Promise<ArtifactListResult> {
	const result = await executeTool('artifact_list', ArtifactListInput, input, ctx, (args) =>
		artifactList(args, ctx),
	)
	return parseToolOutput<ArtifactListResult>(result)
}

async function runTemplatesList(ctx: ArtifactContext): Promise<TypstTemplatesListResult> {
	const result = await executeTool(
		'typst_templates_list',
		TypstTemplatesListInput,
		{},
		ctx,
		(args) => typstTemplatesList(args),
	)
	return parseToolOutput<TypstTemplatesListResult>(result)
}

async function runTypstCompile(
	input: { readonly artifact: string; readonly entry?: string; readonly format?: string },
	ctx: ArtifactContext,
	typstBin: string,
): Promise<TypstCompileResult> {
	const result = await executeTool('typst_compile', TypstCompileInput, input, ctx, (args) =>
		typstCompile(args, ctx, { typstBin }),
	)
	return parseToolOutput<TypstCompileResult>(result)
}

describe('artifact slug validation', () => {
	test('accepts durable artifact slugs', () => {
		expect(artifactSlugFromString('2026-06-29-a3f91c-strategy-brief')).toBeDefined()
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
		const slug = decodeArtifactSlugSync('strategy-brief')
		expect(artifactRelativePath(slug)).toBe('.limitless/artifacts/strategy-brief')
		expect(artifactsRoot('/repo')).toBe(path.resolve('/repo/.limitless/artifacts'))
		expect(artifactDirectoryPath('/repo', slug)).toBe(
			path.resolve('/repo/.limitless/artifacts/strategy-brief'),
		)
	})
})

describe('artifact create and list', () => {
	test('creates a durable scratchpad artifact without session path scoping', async () => {
		await withWorkspace(async (workspace) => {
			const created = await runArtifactCreate(
				{ kind: 'scratchpad', title: 'Pricing notes', slug: 'pricing-notes' },
				context(workspace, 'session-a'),
			)

			expect(created).toMatchObject({
				ok: true,
				slug: 'pricing-notes',
				path: '.limitless/artifacts/pricing-notes',
				manifestPath: '.limitless/artifacts/pricing-notes/manifest.json',
				created: true,
			})
			expect(created.path).not.toContain('session-a')
			expect(await readFile(path.join(workspace, created.path, 'scratch.md'), 'utf8')).toBe('')

			const manifest = JSON.parse(
				await readFile(path.join(workspace, created.manifestPath), 'utf8'),
			) as Record<string, unknown>
			expect(manifest).toMatchObject({
				slug: 'pricing-notes',
				kind: 'scratchpad',
				title: 'Pricing notes',
				createdAt: expect.any(String),
				createdBy: { sessionID: 'session-a', agent: 'limitless' },
			})
			expect(manifest.updatedAt).toBeUndefined()

			const list = await runArtifactList({}, context(workspace, 'session-b'))
			expect(list.artifacts).toEqual([
				{
					slug: 'pricing-notes',
					kind: 'scratchpad',
					title: 'Pricing notes',
					path: '.limitless/artifacts/pricing-notes',
					createdAt: manifest.createdAt,
				},
			])
		})
	})

	test('creates document artifacts from the built-in Typst template', async () => {
		await withWorkspace(async (workspace) => {
			const created = await runArtifactCreate(
				{ kind: 'document', title: 'Strategy Brief', slug: 'strategy-brief' },
				context(workspace),
			)

			expect(created.manifest).toMatchObject({
				slug: 'strategy-brief',
				kind: 'document',
				title: 'Strategy Brief',
				template: 'brief',
			})
			for (const relativePath of ['manifest.json', 'main.typ']) {
				await expect(
					readFile(path.join(workspace, created.path, relativePath), 'utf8'),
				).resolves.toEqual(expect.any(String))
			}

			const list = await runArtifactList({ kind: 'document' }, context(workspace))
			expect(list.artifacts).toHaveLength(1)
			expect(list.artifacts[0]).toMatchObject({
				slug: 'strategy-brief',
				kind: 'document',
				template: 'brief',
			})
		})
	})

	test('lists an empty artifact root before any artifacts are created', async () => {
		await withWorkspace(async (workspace) => {
			await expect(runArtifactList({}, context(workspace))).resolves.toEqual({
				ok: true,
				artifacts: [],
			})
		})
	})

	test('rejects existing artifact workspaces instead of reusing them', async () => {
		await withWorkspace(async (workspace) => {
			const ctx = context(workspace)
			await runArtifactCreate({ slug: 'notes' }, ctx)

			const result = await runArtifactCreatePayload({ slug: 'notes' }, ctx)
			expect(result).toMatchObject({
				ok: false,
				error: 'ToolInputError',
				tool: 'artifact_create',
			})
			expect(JSON.stringify(result)).not.toContain(workspace)
		})
	})

	test('rejects symlink artifact roots', async () => {
		await withWorkspace(async (workspace) => {
			const outside = path.join(workspace, 'outside')
			await mkdir(outside)
			await symlink(outside, path.join(workspace, '.limitless'))

			const result = await runArtifactCreatePayload({ slug: 'plan' }, context(workspace))
			expect(result).toMatchObject({
				ok: false,
				error: 'ToolInputError',
				tool: 'artifact_create',
			})
			expect(JSON.stringify(result)).not.toContain(workspace)
		})
	})
})

describe('typst tools', () => {
	test('lists built-in Typst templates', async () => {
		await withWorkspace(async (workspace) => {
			const result = await runTemplatesList(context(workspace))
			expect(result.templates).toEqual([
				expect.objectContaining({
					name: 'brief',
					defaultEntry: 'main.typ',
					files: ['main.typ', 'assets/', 'dist/'],
				}),
				expect.objectContaining({
					name: 'sphere-institutional',
					defaultEntry: 'main.typ',
					files: ['main.typ', 'sphere.typ', 'assets/', 'dist/'],
				}),
				expect.objectContaining({
					name: 'sphere-institutional-print',
					defaultEntry: 'main.typ',
					files: ['main.typ', 'sphere.typ', 'assets/', 'dist/'],
				}),
				expect.objectContaining({
					name: 'sphere-institutional-showcase',
					defaultEntry: 'main.typ',
					files: ['main.typ', 'sphere.typ', 'assets/', 'dist/'],
				}),
			])
		})
	})

	test('creates Sphere artifacts with packaged Inter fonts', async () => {
		await withWorkspace(async (workspace) => {
			const created = await runArtifactCreate(
				{
					kind: 'document',
					title: 'Sphere Deck',
					slug: 'sphere-deck',
					template: 'sphere-institutional',
				},
				context(workspace),
			)
			const artifactPath = path.join(workspace, created.path)
			await expect(readFile(path.join(artifactPath, 'sphere.typ'), 'utf8')).resolves.toContain(
				'#let sphere-font = "Inter"',
			)
			await expect(readFile(path.join(artifactPath, 'sphere.typ'), 'utf8')).resolves.toContain(
				'image("assets/sphere-logo.svg"',
			)
			await expect(
				readFile(path.join(artifactPath, 'assets', 'sphere-logo.svg'), 'utf8'),
			).resolves.toContain('<svg width="263" height="57"')
			const regularFont = await readFile(
				path.join(artifactPath, 'assets', 'fonts', 'Inter-Variable.ttf'),
			)
			const italicFont = await readFile(
				path.join(artifactPath, 'assets', 'fonts', 'Inter-Italic-Variable.ttf'),
			)
			expect(regularFont.byteLength).toBeGreaterThan(0)
			expect(italicFont.byteLength).toBeGreaterThan(0)
			await expect(
				readFile(path.join(artifactPath, 'assets', 'fonts', 'OFL.txt'), 'utf8'),
			).resolves.toContain('SIL OPEN FONT LICENSE')

			const fakeTypst = path.join(workspace, 'fake-typst')
			await writeFile(
				fakeTypst,
				'#!/bin/sh\nprintf "%s\\n" "$@" > args.txt\nlast=\nfor arg do last=$arg; done\ntouch "$last"\n',
			)
			await chmod(fakeTypst, 0o755)

			const result = await runTypstCompile(
				{ artifact: created.slug },
				context(workspace),
				fakeTypst,
			)

			expect(result).toMatchObject({
				ok: true,
				artifact: 'sphere-deck',
				outputPath: '.limitless/artifacts/sphere-deck/dist/sphere-deck.pdf',
			})
			await expect(readFile(path.join(artifactPath, 'args.txt'), 'utf8')).resolves.toBe(
				[
					'compile',
					'--font-path',
					path.join(artifactPath, 'assets', 'fonts'),
					'--root',
					artifactPath,
					'main.typ',
					'dist/sphere-deck.pdf',
					'',
				].join('\n'),
			)
		})
	})

	test('creates the complete Sphere showcase template', async () => {
		await withWorkspace(async (workspace) => {
			const created = await runArtifactCreate(
				{
					kind: 'document',
					title: 'Sphere Institutional Showcase',
					slug: 'sphere-showcase',
					template: 'sphere-institutional-showcase',
				},
				context(workspace),
			)
			const artifactPath = path.join(workspace, created.path)
			await expect(readFile(path.join(artifactPath, 'main.typ'), 'utf8')).resolves.toContain(
				'Analytical dark mode',
			)
			await expect(readFile(path.join(artifactPath, 'sphere.typ'), 'utf8')).resolves.toContain(
				'#let sphere-step-chart',
			)
		})
	})

	test('compiles a document artifact with the configured Typst binary', async () => {
		await withWorkspace(async (workspace) => {
			const created = await runArtifactCreate(
				{ kind: 'document', title: 'Strategy Brief', slug: 'strategy-brief' },
				context(workspace),
			)
			const fakeTypst = path.join(workspace, 'fake-typst')
			await writeFile(fakeTypst, '#!/bin/sh\nprintf "%s\\n" "$@" > args.txt\ntouch "$5"\n')
			await chmod(fakeTypst, 0o755)

			const result = await runTypstCompile(
				{ artifact: created.slug },
				context(workspace),
				fakeTypst,
			)

			expect(result).toMatchObject({
				ok: true,
				artifact: 'strategy-brief',
				entry: 'main.typ',
				format: 'pdf',
				outputPath: '.limitless/artifacts/strategy-brief/dist/strategy-brief.pdf',
				command: 'typst compile',
				exitCode: 0,
			})
			await expect(
				readFile(path.join(workspace, created.path, 'dist', 'strategy-brief.pdf'), 'utf8'),
			).resolves.toBe('')
			await expect(readFile(path.join(workspace, created.path, 'args.txt'), 'utf8')).resolves.toBe(
				[
					'compile',
					'--root',
					path.join(workspace, created.path),
					'main.typ',
					'dist/strategy-brief.pdf',
					'',
				].join('\n'),
			)
		})
	})
})
