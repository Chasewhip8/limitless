import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Option, Schema } from 'effect'
import { listDirectoryFilesRecursive, readJsonFile } from './fs'
import { isMissingPath, toolInputError, toolOperationError } from './lib/errors'
import {
	ArtifactTemplateManifest,
	ArtifactTemplateName,
	type ArtifactTemplatesListInput,
	type ArtifactTemplatesListResult,
	type ArtifactTemplate as ArtifactTemplateType,
	type InvalidArtifactTemplate,
} from './lib/template'
import { optionalField } from './shared'

export {
	ArtifactTemplate,
	ArtifactTemplateManifest,
	ArtifactTemplateName,
	ArtifactTemplatesListInput,
	type ArtifactTemplatesListResult,
} from './lib/template'

export const DEFAULT_DOCUMENT_TEMPLATE = 'brief'

const TEMPLATE_MANIFEST_FILE = 'manifest.json'
const TEMPLATES_DIRECTORY = 'templates'
const FRAMEWORKS_DIRECTORY = 'frameworks'

function templateNameFromString(value: string): ArtifactTemplateName | undefined {
	const decoded = Schema.decodeUnknownOption(ArtifactTemplateName)(value)
	return Option.isSome(decoded) ? decoded.value : undefined
}

function contentRootCandidates(name: string): ReadonlyArray<string> {
	const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
	return [
		path.resolve(moduleDirectory, name),
		// Nix bundles templates/frameworks beside limitless.js; repo dev keeps them at repo root.
		path.resolve(moduleDirectory, '..', '..', name),
	]
}

const directoryExists = Effect.fn(function* directoryExists(candidate: string, toolName: string) {
	return yield* Effect.tryPromise({
		try: async () => {
			try {
				const info = await lstat(candidate)
				return info.isDirectory()
			} catch (error) {
				if (isMissingPath(error)) return false
				throw error
			}
		},
		catch: (error) => toolOperationError(toolName, 'Could not inspect content directory', error),
	})
})

const ensureContentRoot = Effect.fn(function* ensureContentRoot(name: string, toolName: string) {
	for (const candidate of contentRootCandidates(name)) {
		if (yield* directoryExists(candidate, toolName)) return candidate
	}

	return yield* toolInputError(toolName, `Could not locate built-in ${name}`)
})

const readTemplateDirectory = Effect.fn(function* readTemplateDirectory(
	directory: string,
	toolName: string,
) {
	return yield* Effect.tryPromise({
		try: () => readdir(directory, { withFileTypes: true }),
		catch: (error) => toolOperationError(toolName, 'Could not list template files', error),
	})
})

const readTemplateManifestFile = Effect.fn(function* readTemplateManifestFile(
	directory: string,
	toolName: string,
) {
	return yield* readJsonFile(
		path.join(directory, TEMPLATE_MANIFEST_FILE),
		ArtifactTemplateManifest,
		toolName,
		'template manifest',
	)
})

const resolveDirectory = Effect.fn(function* resolveDirectory(
	root: string,
	name: ArtifactTemplateName,
	toolName: string,
	unknownMessage: string,
) {
	const directory = path.join(root, name)
	const exists = yield* directoryExists(directory, toolName)
	if (!exists) return yield* toolInputError(toolName, unknownMessage)
	return directory
})

const resolveFrameworkDirectory = Effect.fn(function* resolveFrameworkDirectory(
	name: ArtifactTemplateName,
	toolName: string,
) {
	const root = yield* ensureContentRoot(FRAMEWORKS_DIRECTORY, toolName)
	return yield* resolveDirectory(root, name, toolName, `unknown artifact framework: ${name}`)
})

export const resolveArtifactTemplate = Effect.fn(function* resolveArtifactTemplate(
	template: string,
	toolName: string,
) {
	const name = templateNameFromString(template)
	if (name === undefined) {
		return yield* toolInputError(toolName, 'template must be a single path segment')
	}

	const root = yield* ensureContentRoot(TEMPLATES_DIRECTORY, toolName)
	const directory = yield* resolveDirectory(
		root,
		name,
		toolName,
		`unknown artifact template: ${name}`,
	)
	const manifest = yield* readTemplateManifestFile(directory, toolName)
	if (manifest.name !== name) {
		return yield* toolInputError(toolName, 'Template manifest name mismatch')
	}
	const frameworkDirectory =
		manifest.framework === undefined
			? undefined
			: yield* resolveFrameworkDirectory(manifest.framework, toolName)

	return {
		name,
		directory,
		...optionalField('frameworkDirectory', frameworkDirectory),
		manifest,
	}
})

const composedTemplateFiles = Effect.fn(function* composedTemplateFiles(
	templateDirectory: string,
	frameworkDirectory: string | undefined,
	toolName: string,
) {
	const files = new Set<string>()
	if (frameworkDirectory !== undefined) {
		for (const file of yield* listDirectoryFilesRecursive(frameworkDirectory, toolName)) {
			files.add(file)
		}
	}
	for (const file of yield* listDirectoryFilesRecursive(templateDirectory, toolName, [
		TEMPLATE_MANIFEST_FILE,
	])) {
		files.add(file)
	}
	return [...files].sort((left, right) => left.localeCompare(right))
})

export const artifactTemplatesList = Effect.fn(function* artifactTemplatesList(
	_input: typeof ArtifactTemplatesListInput.Type,
) {
	const toolName = 'artifact_templates_list'
	const root = yield* ensureContentRoot(TEMPLATES_DIRECTORY, toolName)
	const entries = yield* readTemplateDirectory(root, toolName)
	const templates: Array<ArtifactTemplateType> = []
	const invalidTemplates: Array<InvalidArtifactTemplate> = []

	for (const entry of entries.slice().sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isDirectory()) continue
		const name = templateNameFromString(entry.name)
		if (name === undefined) {
			invalidTemplates.push({ name: entry.name, reason: 'template directory name is invalid' })
			continue
		}

		const directory = path.join(root, name)
		const manifestResult = yield* readTemplateManifestFile(directory, toolName).pipe(
			Effect.match({
				onFailure: () => ({ ok: false as const }),
				onSuccess: (value) => ({ ok: true as const, value }),
			}),
		)
		if (!manifestResult.ok) {
			invalidTemplates.push({ name, reason: 'manifest.json is missing or invalid' })
			continue
		}
		if (manifestResult.value.name !== name) {
			invalidTemplates.push({ name, reason: 'manifest.json name does not match directory' })
			continue
		}

		const frameworkDirectoryResult =
			manifestResult.value.framework === undefined
				? { ok: true as const, value: undefined }
				: yield* resolveFrameworkDirectory(manifestResult.value.framework, toolName).pipe(
						Effect.match({
							onFailure: () => ({ ok: false as const }),
							onSuccess: (value) => ({ ok: true as const, value }),
						}),
					)
		if (!frameworkDirectoryResult.ok) {
			invalidTemplates.push({ name, reason: 'declared framework directory is missing' })
			continue
		}

		const filesResult = yield* composedTemplateFiles(
			directory,
			frameworkDirectoryResult.value,
			toolName,
		).pipe(
			Effect.match({
				onFailure: () => ({ ok: false as const }),
				onSuccess: (value) => ({ ok: true as const, value }),
			}),
		)
		if (!filesResult.ok) {
			invalidTemplates.push({ name, reason: 'template files could not be listed' })
			continue
		}

		templates.push({
			name: manifestResult.value.name,
			description: manifestResult.value.description,
			path: path.posix.join(TEMPLATES_DIRECTORY, manifestResult.value.name),
			files: filesResult.value,
			...optionalField('title', manifestResult.value.title),
			...optionalField('kind', manifestResult.value.kind),
			...optionalField('framework', manifestResult.value.framework),
			...optionalField('authoring', manifestResult.value.authoring),
		})
	}

	return {
		ok: true,
		templates,
		...optionalField(
			'invalidTemplates',
			invalidTemplates.length > 0 ? invalidTemplates : undefined,
		),
	} satisfies ArtifactTemplatesListResult
})
