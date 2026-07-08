#!/usr/bin/env bun

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactCreate, decodeArtifactSlugSync } from '../packages/limitless/artifacts'
import { ArtifactCreateInput, type ArtifactCreateResult } from '../packages/limitless/lib/artifact'
import {
	ArtifactTemplatesListInput,
	type ArtifactTemplatesListResult,
} from '../packages/limitless/lib/template'
import { TypstCompileInput, type TypstCompileResult } from '../packages/limitless/lib/typst'
import { executeTool } from '../packages/limitless/shared'
import { artifactTemplatesList } from '../packages/limitless/templates'
import { typstCompile } from '../packages/limitless/typst'

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

// Only ever delete this script's own example artifacts; other artifacts in the
// workspace (notes, documents) belong to users and agents.
async function removeExampleArtifact(slug: ArtifactSlugValue): Promise<void> {
	const target = path.join(artifactsDirectory, slug)
	const relativeTarget = path.relative(worktree, target)
	if (!relativeTarget.startsWith(path.join('.limitless', 'artifacts', 'example-'))) {
		throw new Error(`Refusing to delete unexpected artifacts path: ${target}`)
	}
	await rm(target, { recursive: true, force: true })
}

function titleForTemplate(templateName: string): string {
	return `${templateName
		.split('-')
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join(' ')} Example`
}

async function listTemplates(): Promise<ArtifactTemplatesListResult> {
	const payload = parseToolOutput<ArtifactTemplatesListResult | ToolFailurePayload>(
		await executeTool('artifact_templates_list', ArtifactTemplatesListInput, {}, context, (args) =>
			artifactTemplatesList(args),
		),
	)
	return assertToolSuccess('artifact_templates_list', payload)
}

async function createDocument(input: {
	readonly title: string
	readonly slug: ArtifactSlugValue
	readonly template: string
}): Promise<ArtifactCreateResult> {
	const payload = parseToolOutput<ArtifactCreateResult | ToolFailurePayload>(
		await executeTool('artifact_create', ArtifactCreateInput, input, context, (args) =>
			artifactCreate(args, context),
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
	const templates = await listTemplates()
	const generated: GeneratedExample[] = []

	for (const template of templates.templates.filter((candidate) =>
		candidate.files.includes('main.typ'),
	)) {
		const slug = decodeArtifactSlugSync(`example-${template.name}`)
		await removeExampleArtifact(slug)
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
