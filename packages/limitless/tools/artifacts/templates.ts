import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Option, Result, Schema } from 'effect'
import { isMissingPath, toolInputError, toolOperationError } from '../../core/errors'
import { optionalField } from '../../lib/type-utils'
import { listDirectoryFilesRecursive, readJsonFile } from './filesystem'
import { ArtifactTemplateManifest, ArtifactTemplateName, ResolvedArtifactTemplate } from './schema'

export const ArtifactTemplateFilePath = Schema.String.check(
	Schema.makeFilter((value) => {
		if (value.length === 0) return 'file is required'
		if (value.startsWith('/') || value.includes('\\'))
			return 'file must be a relative template file path'
		const segments = value.split('/')
		return segments.some((segment) => segment === '' || segment === '.' || segment === '..')
			? 'file must be a relative template file path'
			: true
	}),
).pipe(Schema.brand('ArtifactTemplateFilePath'))

export const ArtifactTemplate = Schema.Struct({
	name: ArtifactTemplateName,
	description: Schema.String,
	path: Schema.String,
	files: Schema.Array(Schema.String),
	title: Schema.optional(Schema.String),
	framework: Schema.optional(ArtifactTemplateName),
	authoring: Schema.optional(Schema.String),
})
type ArtifactTemplateType = typeof ArtifactTemplate.Type
const InvalidArtifactTemplate = Schema.Struct({ name: Schema.String, reason: Schema.String })
type InvalidArtifactTemplate = typeof InvalidArtifactTemplate.Type
export const ArtifactTemplatesListInput = Schema.Struct({})
export const ArtifactTemplatesListResult = Schema.Struct({
	ok: Schema.Literal(true),
	templates: Schema.Array(ArtifactTemplate),
	invalidTemplates: Schema.optional(Schema.Array(InvalidArtifactTemplate)),
})
export type ArtifactTemplatesListResult = typeof ArtifactTemplatesListResult.Type
export const ArtifactTemplateReadInput = Schema.Struct({
	template: ArtifactTemplateName,
	file: ArtifactTemplateFilePath,
})
export type ArtifactTemplateReadInput = typeof ArtifactTemplateReadInput.Type
export const ArtifactTemplateReadResult = Schema.Struct({
	ok: Schema.Literal(true),
	template: ArtifactTemplateName,
	file: ArtifactTemplateFilePath,
	content: Schema.String,
})
export type ArtifactTemplateReadResult = typeof ArtifactTemplateReadResult.Type

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
		path.resolve(moduleDirectory, '..', '..', '..', '..', name),
	]
}

const directoryExists = Effect.fn(function* directoryExists(candidate: string, toolName: string) {
	return yield* Effect.tryPromise({
		try: () => lstat(candidate),
		catch: (error) => toolOperationError(toolName, 'Could not inspect content directory', error),
	}).pipe(
		Effect.matchEffect({
			onFailure: (error) => (isMissingPath(error) ? Effect.succeed(false) : Effect.fail(error)),
			onSuccess: (info) => Effect.succeed(info.isDirectory()),
		}),
	)
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

	return ResolvedArtifactTemplate.make({
		name,
		directory,
		...optionalField('frameworkDirectory', frameworkDirectory),
		manifest,
	})
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

const MAX_TEMPLATE_FILE_BYTES = 256 * 1024

const readTemplateFileBuffer = Effect.fn(function* readTemplateFileBuffer(
	filePath: string,
	toolName: string,
) {
	const info = yield* Effect.tryPromise({
		try: () => lstat(filePath),
		catch: (error) => toolOperationError(toolName, 'Could not read template file', error),
	}).pipe(
		Effect.matchEffect({
			onFailure: (error) => (isMissingPath(error) ? Effect.void : Effect.fail(error)),
			onSuccess: Effect.succeed,
		}),
	)
	if (info === undefined || !info.isFile()) return undefined
	return yield* Effect.tryPromise({
		try: (signal) => readFile(filePath, { signal }),
		catch: (error) => toolOperationError(toolName, 'Could not read template file', error),
	})
})

export const artifactTemplateRead = Effect.fn(function* artifactTemplateRead(
	input: ArtifactTemplateReadInput,
) {
	const toolName = 'artifact_template_read'
	const template = yield* resolveArtifactTemplate(input.template, toolName)
	const files = yield* composedTemplateFiles(
		template.directory,
		template.frameworkDirectory,
		toolName,
	)
	if (input.file.endsWith('/') || !files.includes(input.file)) {
		return yield* toolInputError(toolName, `unknown template file: ${input.file}`)
	}

	// artifact_create copies the framework first and the template on top, so
	// probe the template directory before the framework directory.
	const roots = [template.directory, template.frameworkDirectory].filter(
		(root): root is string => root !== undefined,
	)
	let buffer: Buffer | undefined
	for (const root of roots) {
		buffer = yield* readTemplateFileBuffer(path.join(root, input.file), toolName)
		if (buffer !== undefined) break
	}
	if (buffer === undefined) {
		return yield* toolInputError(toolName, `unknown template file: ${input.file}`)
	}
	if (buffer.byteLength > MAX_TEMPLATE_FILE_BYTES) {
		return yield* toolInputError(
			toolName,
			'template file is too large to read inline; create an artifact from the template to copy it',
		)
	}
	if (buffer.includes(0)) {
		return yield* toolInputError(
			toolName,
			'template file is binary; only text files can be read inline',
		)
	}

	return ArtifactTemplateReadResult.make({
		ok: true,
		template: template.name,
		file: input.file,
		content: buffer.toString('utf8'),
	})
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
		const manifestResult = yield* Effect.result(readTemplateManifestFile(directory, toolName))
		if (Result.isFailure(manifestResult)) {
			if (
				manifestResult.failure._tag !== 'ToolInputError' &&
				!isMissingPath(manifestResult.failure)
			) {
				return yield* manifestResult.failure
			}
			invalidTemplates.push({ name, reason: 'manifest.json is missing or invalid' })
			continue
		}
		if (manifestResult.success.name !== name) {
			invalidTemplates.push({ name, reason: 'manifest.json name does not match directory' })
			continue
		}

		const frameworkDirectoryResult =
			manifestResult.success.framework === undefined
				? Result.succeed(undefined)
				: yield* Effect.result(
						resolveFrameworkDirectory(manifestResult.success.framework, toolName),
					)
		if (Result.isFailure(frameworkDirectoryResult)) {
			if (frameworkDirectoryResult.failure._tag !== 'ToolInputError') {
				return yield* frameworkDirectoryResult.failure
			}
			invalidTemplates.push({ name, reason: 'declared framework directory is missing' })
			continue
		}

		const filesResult = yield* Effect.result(
			composedTemplateFiles(directory, frameworkDirectoryResult.success, toolName),
		)
		if (Result.isFailure(filesResult)) {
			if (filesResult.failure._tag !== 'ToolInputError') return yield* filesResult.failure
			invalidTemplates.push({ name, reason: 'template files could not be listed' })
			continue
		}

		templates.push({
			name: manifestResult.success.name,
			description: manifestResult.success.description,
			path: path.posix.join(TEMPLATES_DIRECTORY, manifestResult.success.name),
			files: filesResult.success,
			...optionalField('title', manifestResult.success.title),
			...optionalField('framework', manifestResult.success.framework),
			...optionalField('authoring', manifestResult.success.authoring),
		})
	}

	return ArtifactTemplatesListResult.make({
		ok: true,
		templates,
		...optionalField(
			'invalidTemplates',
			invalidTemplates.length > 0 ? invalidTemplates : undefined,
		),
	})
})
