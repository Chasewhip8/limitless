#!/usr/bin/env bun

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { toolOperationError } from '../packages/limitless/core/errors'
import {
	type ArtifactCreateInput,
	type ArtifactSlug,
	ArtifactTemplatesListInput,
	artifactCreate,
	artifactsRoot,
	artifactTemplatesList,
	decodeArtifactSlug,
	typstCompile,
} from '../packages/limitless/tools/artifacts/index'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const worktree = path.resolve(scriptDirectory, '..')
const artifactsDirectory = artifactsRoot(worktree)

const context: Parameters<typeof artifactCreate>[1] = {
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
		return JSON.stringify(error, null, 2) ?? String(error)
	} catch {
		return String(error)
	}
}

// Only ever delete this script's own example artifacts; other artifacts in the
// workspace (notes, documents) belong to users and agents.
function removeExampleArtifact(slug: ArtifactSlug) {
	return Effect.gen(function* () {
		const target = path.join(artifactsDirectory, slug)
		if (path.dirname(target) !== artifactsDirectory || !slug.startsWith('example-')) {
			return yield* toolOperationError(
				'examples:docs',
				`Refusing to delete unexpected artifacts path: ${target}`,
				target,
			)
		}
		yield* Effect.tryPromise({
			try: () => rm(target, { recursive: true, force: true }),
			catch: (error) =>
				toolOperationError('examples:docs', 'Could not remove example artifact', error),
		})
	})
}

function titleForTemplate(templateName: string): string {
	return `${templateName
		.split('-')
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join(' ')} Example`
}

const listTemplates = Effect.fn(function* listTemplates() {
	return yield* artifactTemplatesList(ArtifactTemplatesListInput.make({}))
})

const createDocument = Effect.fn(function* createDocument(input: typeof ArtifactCreateInput.Type) {
	return yield* artifactCreate(input, context)
})

const compileDocument = Effect.fn(function* compileDocument(slug: ArtifactSlug, typstBin: string) {
	return yield* typstCompile({ artifact: slug, timeoutMs: 120_000 }, context, { typstBin })
})

const main = Effect.fn(function* main() {
	const typstBin = yield* Effect.sync(() => process.env.TYPST_BIN ?? 'typst')
	const templates = yield* listTemplates()
	const generatedLines: Array<string> = []

	for (const template of templates.templates.filter((candidate) =>
		candidate.files.includes('main.typ'),
	)) {
		const slug = yield* decodeArtifactSlug(`example-${template.name}`)
		yield* removeExampleArtifact(slug)
		yield* createDocument({
			title: titleForTemplate(template.name),
			slug,
			template: template.name,
		})
		const compiled = yield* compileDocument(slug, typstBin)

		if (!compiled.ok) {
			return yield* toolOperationError(
				'typst_compile',
				[
					`Typst failed for template ${template.name}`,
					`exitCode: ${compiled.exitCode}`,
					compiled.stdout.trim(),
					compiled.stderr.trim(),
				]
					.filter((line) => line.length > 0)
					.join('\n'),
				compiled,
			)
		}

		generatedLines.push(`- ${template.name}: ${compiled.outputPath}`)
	}

	return generatedLines
})

Effect.runPromise(main()).then(
	(generatedLines) => {
		console.log('Generated example documents:')
		for (const line of generatedLines) console.log(line)
	},
	(error: unknown) => {
		console.error(describeError(error))
		process.exitCode = 1
	},
)
