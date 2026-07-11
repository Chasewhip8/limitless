import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { executeTool } from '../core/tool-boundary'
import {
	ArtifactCreateInput,
	ArtifactCreateResult,
	artifactCreate,
} from '../tools/artifacts/create'
import {
	ArtifactListInput,
	ArtifactListResult,
	artifactList,
	artifactSlugFromString,
} from '../tools/artifacts/list'
import {
	artifactDirectoryPath,
	artifactRelativePath,
	artifactsRoot,
} from '../tools/artifacts/paths'
import {
	ArtifactTemplateReadInput,
	ArtifactTemplateReadResult,
	ArtifactTemplatesListInput,
	ArtifactTemplatesListResult,
	artifactTemplateRead,
	artifactTemplatesList,
} from '../tools/artifacts/templates'
import { TypstCompileInput, TypstCompileResult, typstCompile } from '../tools/artifacts/typst'

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

function parseToolOutput<Input, Decoded>(
	schema: { readonly make: (input: Input) => Decoded },
	result: Awaited<ReturnType<typeof executeTool>>,
): Decoded {
	return schema.make(JSON.parse(typeof result === 'string' ? result : result.output))
}

function parseUnknownToolOutput(result: Awaited<ReturnType<typeof executeTool>>): unknown {
	return JSON.parse(typeof result === 'string' ? result : result.output) as unknown
}

async function runArtifactCreate(
	input: {
		readonly title?: string
		readonly slug?: string
		readonly template?: string
	},
	ctx: ArtifactContext,
): Promise<ArtifactCreateResult> {
	const result = await executeTool(
		'artifact_create',
		ArtifactCreateInput,
		ArtifactCreateResult,
		input,
		ctx,
		(args) => artifactCreate(args, ctx),
	)
	return parseToolOutput(ArtifactCreateResult, result)
}

async function runArtifactCreatePayload(
	input: {
		readonly title?: string
		readonly slug?: string
		readonly template?: string
	},
	ctx: ArtifactContext,
): Promise<unknown> {
	const result = await executeTool(
		'artifact_create',
		ArtifactCreateInput,
		ArtifactCreateResult,
		input,
		ctx,
		(args) => artifactCreate(args, ctx),
	)
	return parseUnknownToolOutput(result)
}

async function runArtifactList(
	input: { readonly template?: string },
	ctx: ArtifactContext,
): Promise<ArtifactListResult> {
	const result = await executeTool(
		'artifact_list',
		ArtifactListInput,
		ArtifactListResult,
		input,
		ctx,
		(args) => artifactList(args, ctx),
	)
	return parseToolOutput(ArtifactListResult, result)
}

async function runTemplatesList(ctx: ArtifactContext): Promise<ArtifactTemplatesListResult> {
	const result = await executeTool(
		'artifact_templates_list',
		ArtifactTemplatesListInput,
		ArtifactTemplatesListResult,
		{},
		ctx,
		(args) => artifactTemplatesList(args),
	)
	return parseToolOutput(ArtifactTemplatesListResult, result)
}

async function runTemplateRead(
	input: { readonly template?: string; readonly file?: string },
	ctx: ArtifactContext,
): Promise<ArtifactTemplateReadResult> {
	const result = await executeTool(
		'artifact_template_read',
		ArtifactTemplateReadInput,
		ArtifactTemplateReadResult,
		input,
		ctx,
		(args) => artifactTemplateRead(args),
	)
	return parseToolOutput(ArtifactTemplateReadResult, result)
}

async function runTemplateReadPayload(
	input: { readonly template?: string; readonly file?: string },
	ctx: ArtifactContext,
): Promise<unknown> {
	const result = await executeTool(
		'artifact_template_read',
		ArtifactTemplateReadInput,
		ArtifactTemplateReadResult,
		input,
		ctx,
		(args) => artifactTemplateRead(args),
	)
	return parseUnknownToolOutput(result)
}

async function runTypstCompile(
	input: {
		readonly artifact: string
		readonly entry?: string
		readonly format?: string
		readonly timeoutMs?: number
	},
	ctx: ArtifactContext,
	typstBin: string,
): Promise<TypstCompileResult> {
	const result = await executeTool(
		'typst_compile',
		TypstCompileInput,
		TypstCompileResult,
		input,
		ctx,
		(args) => typstCompile(args, ctx, { typstBin }),
	)
	return parseToolOutput(TypstCompileResult, result)
}

async function runTypstCompilePayload(
	input: {
		readonly artifact: string
		readonly entry?: string
		readonly format?: string
		readonly timeoutMs?: number
	},
	ctx: ArtifactContext,
): Promise<unknown> {
	const result = await executeTool(
		'typst_compile',
		TypstCompileInput,
		TypstCompileResult,
		input,
		ctx,
		(args) => typstCompile(args, ctx),
	)
	return parseUnknownToolOutput(result)
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
		const slug = artifactSlugFromString('strategy-brief')
		if (slug === undefined) throw new Error('expected a valid artifact slug')
		expect(artifactRelativePath(slug)).toBe('.limitless/artifacts/strategy-brief')
		expect(artifactsRoot('/repo')).toBe(path.resolve('/repo/.limitless/artifacts'))
		expect(artifactDirectoryPath('/repo', slug)).toBe(
			path.resolve('/repo/.limitless/artifacts/strategy-brief'),
		)
	})
})

describe('artifact create and list', () => {
	test('creates an empty artifact without session path scoping', async () => {
		await withWorkspace(async (workspace) => {
			const created = await runArtifactCreate(
				{ title: 'Pricing notes', slug: 'pricing-notes' },
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
			expect((await readdir(path.join(workspace, created.path))).sort()).toEqual(['manifest.json'])

			const manifest = JSON.parse(
				await readFile(path.join(workspace, created.manifestPath), 'utf8'),
			) as Record<string, unknown>
			expect(manifest).toMatchObject({
				slug: 'pricing-notes',
				title: 'Pricing notes',
				createdAt: expect.any(String),
				createdBy: { sessionID: 'session-a', agent: 'limitless' },
			})
			expect(manifest.kind).toBeUndefined()
			expect(manifest.template).toBeUndefined()
			expect(manifest.updatedAt).toBeUndefined()

			const list = await runArtifactList({}, context(workspace, 'session-b'))
			expect(list.artifacts).toEqual([
				{
					slug: 'pricing-notes',
					title: 'Pricing notes',
					path: '.limitless/artifacts/pricing-notes',
					createdAt: manifest.createdAt,
				},
			])
		})
	})

	test('creates artifacts from the built-in template', async () => {
		await withWorkspace(async (workspace) => {
			const created = await runArtifactCreate(
				{ template: 'brief', title: 'Strategy Brief', slug: 'strategy-brief' },
				context(workspace),
			)

			expect(created.manifest).toMatchObject({
				slug: 'strategy-brief',
				title: 'Strategy Brief',
				template: 'brief',
			})
			expect(created.manifest).not.toHaveProperty('kind')
			for (const relativePath of ['manifest.json', 'main.typ']) {
				await expect(
					readFile(path.join(workspace, created.path, relativePath), 'utf8'),
				).resolves.toEqual(expect.any(String))
			}

			const list = await runArtifactList({ template: 'brief' }, context(workspace))
			expect(list.artifacts).toHaveLength(1)
			expect(list.artifacts[0]).toMatchObject({
				slug: 'strategy-brief',
				template: 'brief',
			})
			expect(list.artifacts[0]).not.toHaveProperty('kind')
		})
	})

	test('records the template when template is specified', async () => {
		await withWorkspace(async (workspace) => {
			const created = await runArtifactCreate(
				{ title: 'Sphere Deck', slug: 'sphere-template', template: 'sphere' },
				context(workspace),
			)

			expect(created.manifest).toMatchObject({
				slug: 'sphere-template',
				template: 'sphere',
			})
			expect(created.manifest).not.toHaveProperty('kind')
			await expect(
				readFile(path.join(workspace, created.path, 'sphere.typ'), 'utf8'),
			).resolves.toContain('#import "sphere/theme.typ"')
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
				error: 'ToolOperationError',
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
				error: 'ToolOperationError',
				tool: 'artifact_create',
			})
			expect(JSON.stringify(result)).not.toContain(workspace)
		})
	})
})

describe('template and typst tools', () => {
	test('rejects unsupported formats and non-positive timeouts at the schema boundary', async () => {
		await withWorkspace(async (workspace) => {
			for (const input of [
				{ artifact: 'document', format: 'svg' },
				{ artifact: 'document', timeoutMs: 0 },
			]) {
				await expect(runTypstCompilePayload(input, context(workspace))).resolves.toMatchObject({
					ok: false,
					error: 'ToolInputError',
					tool: 'typst_compile',
				})
			}
		})
	})

	test('lists built-in artifact templates', async () => {
		await withWorkspace(async (workspace) => {
			const result = await runTemplatesList(context(workspace))
			expect(result.templates.map((entry) => entry.name)).toEqual([
				'brief',
				'sphere',
				'sphere-showcase',
			])

			const [brief, sphere] = result.templates
			expect(brief).toMatchObject({
				name: 'brief',
				path: 'templates/brief',
				files: ['main.typ'],
			})
			expect(brief).not.toHaveProperty('kind')
			expect(brief).not.toHaveProperty('framework')
			expect(brief).not.toHaveProperty('metadata')

			expect(sphere).toMatchObject({
				name: 'sphere',
				framework: 'sphere',
				path: 'templates/sphere',
				authoring: expect.any(String),
				files: expect.arrayContaining([
					'main.typ',
					'sphere.typ',
					'sphere/',
					'sphere/theme.typ',
					'assets/',
					'assets/fonts/Inter-Variable.ttf',
				]),
			})
			expect(sphere).not.toHaveProperty('kind')
			expect(sphere).not.toHaveProperty('metadata')
		})
	})

	test('creates Sphere artifacts with packaged Inter fonts', async () => {
		await withWorkspace(async (workspace) => {
			const created = await runArtifactCreate(
				{
					title: 'Sphere Deck',
					slug: 'sphere-deck',
					template: 'sphere',
				},
				context(workspace),
			)
			const artifactPath = path.join(workspace, created.path)
			await expect(readFile(path.join(artifactPath, 'main.typ'), 'utf8')).resolves.toEqual(
				expect.any(String),
			)
			await expect(
				readFile(path.join(artifactPath, 'sphere', 'theme.typ'), 'utf8'),
			).resolves.toContain('#let sphere-font = "Inter"')
			await expect(
				readFile(path.join(artifactPath, 'sphere', 'chrome.typ'), 'utf8'),
			).resolves.toContain('image("../assets/sphere-logo.svg"')
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
					title: 'Sphere Institutional Showcase',
					slug: 'sphere-showcase',
					template: 'sphere-showcase',
				},
				context(workspace),
			)
			const artifactPath = path.join(workspace, created.path)
			await expect(readFile(path.join(artifactPath, 'main.typ'), 'utf8')).resolves.toContain(
				'#sphere-kpi-page(',
			)
			await expect(
				readFile(path.join(artifactPath, 'sphere', 'charts.typ'), 'utf8'),
			).resolves.toContain('#let sphere-column-chart')
		})
	})

	test('reads template and framework files without creating an artifact', async () => {
		await withWorkspace(async (workspace) => {
			const ctx = context(workspace)

			const main = await runTemplateRead({ template: 'sphere-showcase', file: 'main.typ' }, ctx)
			expect(main).toMatchObject({ ok: true, template: 'sphere-showcase', file: 'main.typ' })
			expect(main.content).toContain('#sphere-kpi-page(')

			const theme = await runTemplateRead(
				{ template: 'sphere-showcase', file: 'sphere/theme.typ' },
				ctx,
			)
			expect(theme.content).toContain('#let sphere-font = "Inter"')

			const listed = await runArtifactList({}, ctx)
			expect(listed.artifacts).toEqual([])
		})
	})

	test('rejects unknown, traversal, directory, and binary template file reads', async () => {
		await withWorkspace(async (workspace) => {
			const ctx = context(workspace)
			const rejected = [
				{ template: 'sphere-showcase', file: 'missing.typ' },
				{ template: 'sphere-showcase', file: 'sphere/' },
				{ template: 'sphere-showcase', file: '../sphere/main.typ' },
				{ template: 'sphere-showcase', file: '/etc/passwd' },
				{ template: 'unknown-template', file: 'main.typ' },
				{ template: 'sphere-showcase', file: 'assets/cover.png' },
				{ template: 'sphere-showcase', file: 'assets/fonts/Inter-Variable.ttf' },
			]
			for (const input of rejected) {
				await expect(runTemplateReadPayload(input, ctx)).resolves.toMatchObject({
					ok: false,
					error: 'ToolInputError',
					tool: 'artifact_template_read',
				})
			}
		})
	})

	test('rejects unknown templates', async () => {
		await withWorkspace(async (workspace) => {
			const ctx = context(workspace)
			await expect(
				runArtifactCreatePayload({ slug: 'bad-template', template: 'unknown-template' }, ctx),
			).resolves.toMatchObject({
				ok: false,
				error: 'ToolInputError',
				tool: 'artifact_create',
			})
		})
	})

	test('compiles a document artifact with the configured Typst binary', async () => {
		await withWorkspace(async (workspace) => {
			const created = await runArtifactCreate(
				{ template: 'brief', title: 'Strategy Brief', slug: 'strategy-brief' },
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
