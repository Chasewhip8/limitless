#!/usr/bin/env bun

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	ArtifactCreateInput,
	type ArtifactCreateResult,
	artifactCreate,
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

type GeneratedExample = {
	readonly template: string
	readonly artifactPath: string
	readonly pdfPath: string
}

type ArtifactSlugValue = ReturnType<typeof decodeArtifactSlugSync>

type ToolFailurePayload = {
	readonly ok: false
	readonly error: string
	readonly message?: string
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const worktree = path.resolve(scriptDirectory, '..')
const artifactsDirectory = path.join(worktree, '.limitless', 'artifacts')
const typstBin = process.env.TYPST_BIN ?? 'typst'

const context: ArtifactContext = {
	sessionID: 'generate-example-docs',
	messageID: 'generate-example-docs',
	agent: 'limitless',
	directory: worktree,
	worktree,
	abort: new AbortController().signal,
	metadata: () => undefined,
	ask: () => {
		throw new Error('generate-example-docs does not ask interactive questions')
	},
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.stack ?? error.message
	try {
		return JSON.stringify(error, null, 2)
	} catch {
		return String(error)
	}
}

function parseToolOutput<T>(result: Awaited<ReturnType<typeof executeTool>>): T {
	return JSON.parse(typeof result === 'string' ? result : result.output) as T
}

function isToolFailurePayload(value: unknown): value is ToolFailurePayload {
	return (
		typeof value === 'object' &&
		value !== null &&
		'ok' in value &&
		value.ok === false &&
		'error' in value &&
		typeof value.error === 'string'
	)
}

function assertToolSuccess<T>(toolName: string, payload: T | ToolFailurePayload): T {
	if (!isToolFailurePayload(payload)) return payload
	throw new Error(`${toolName} failed: ${payload.message ?? payload.error}`)
}

function assertSafeArtifactsDirectory(): void {
	const relativeTarget = path.relative(worktree, artifactsDirectory)
	if (relativeTarget !== path.join('.limitless', 'artifacts')) {
		throw new Error(`Refusing to delete unexpected artifacts path: ${artifactsDirectory}`)
	}
}

function titleForTemplate(templateName: string): string {
	return `${templateName
		.split('-')
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join(' ')} Example`
}

async function listTemplates(): Promise<TypstTemplatesListResult> {
	const payload = parseToolOutput<TypstTemplatesListResult | ToolFailurePayload>(
		await executeTool('typst_templates_list', TypstTemplatesListInput, {}, context, (args) =>
			typstTemplatesList(args),
		),
	)
	return assertToolSuccess('typst_templates_list', payload)
}

async function createDocument(input: {
	readonly title: string
	readonly slug: ArtifactSlugValue
	readonly template: string
}): Promise<ArtifactCreateResult> {
	const payload = parseToolOutput<ArtifactCreateResult | ToolFailurePayload>(
		await executeTool(
			'artifact_create',
			ArtifactCreateInput,
			{ kind: 'document', ...input },
			context,
			(args) => artifactCreate(args, context),
		),
	)
	return assertToolSuccess('artifact_create', payload)
}

async function compileDocument(slug: ArtifactSlugValue): Promise<TypstCompileResult> {
	const payload = parseToolOutput<TypstCompileResult | ToolFailurePayload>(
		await executeTool(
			'typst_compile',
			TypstCompileInput,
			{ artifact: slug, timeoutMs: 120_000 },
			context,
			(args) => typstCompile(args, context, { typstBin }),
		),
	)
	return assertToolSuccess('typst_compile', payload)
}

async function main(): Promise<void> {
	assertSafeArtifactsDirectory()
	await rm(artifactsDirectory, { recursive: true, force: true })
	console.log(`Deleted ${path.relative(worktree, artifactsDirectory)}`)

	const templates = await listTemplates()
	const generated: GeneratedExample[] = []

	for (const template of templates.templates) {
		const slug = decodeArtifactSlugSync(`example-${template.name}`)
		const created = await createDocument({
			title: titleForTemplate(template.name),
			slug,
			template: template.name,
		})
		const compiled = await compileDocument(slug)

		if (!compiled.ok) {
			throw new Error(
				[
					`Typst failed for template ${template.name}`,
					`exitCode: ${compiled.exitCode}`,
					compiled.stdout.trim(),
					compiled.stderr.trim(),
				]
					.filter((line) => line.length > 0)
					.join('\n'),
			)
		}

		generated.push({
			template: template.name,
			artifactPath: created.path,
			pdfPath: compiled.outputPath,
		})
	}

	console.log('Generated example documents:')
	for (const example of generated) {
		console.log(`- ${example.template}: ${example.pdfPath}`)
	}
}

main().catch((error: unknown) => {
	console.error(describeError(error))
	process.exitCode = 1
})
