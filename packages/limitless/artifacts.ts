import { randomBytes } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { ToolContext } from '@opencode-ai/plugin'
import { Effect, Option, Schema } from 'effect'
import {
	copyDirectoryContents,
	ensureDirectory,
	readJsonFile,
	writeJsonFile,
	writeNewFile,
} from './fs'
import {
	type ArtifactCreateInput,
	type ArtifactCreateResult,
	ArtifactKind,
	type ArtifactKind as ArtifactKindType,
	type ArtifactListEntry,
	type ArtifactListInput,
	type ArtifactListResult,
	type ArtifactManifest,
	ArtifactManifest as ArtifactManifestSchema,
	ArtifactSlug,
	type ArtifactSlug as ArtifactSlugType,
	type InvalidArtifactListEntry,
} from './lib/artifact'
import { isAlreadyExists, toolInputError, toolOperationError } from './lib/errors'
import type { ArtifactTemplateName } from './lib/template'
import { optionalField } from './shared'
import { DEFAULT_DOCUMENT_TEMPLATE, resolveArtifactTemplate } from './templates'

export {
	ArtifactCreateInput,
	type ArtifactCreateResult,
	ArtifactFileName,
	ArtifactKind,
	ArtifactListInput,
	type ArtifactListResult,
	ArtifactManifest,
	ArtifactSlug,
} from './lib/artifact'

export const LIMITLESS_DIRECTORY = '.limitless'
export const ARTIFACTS_DIRECTORY = 'artifacts'
export const ARTIFACTS_RELATIVE_DIRECTORY = path.posix.join(
	LIMITLESS_DIRECTORY,
	ARTIFACTS_DIRECTORY,
)

const TEMPLATE_MANIFEST_FILE = 'manifest.json'
const MAX_TITLE_LENGTH = 160

export const decodeArtifactSlugSync = Schema.decodeUnknownSync(ArtifactSlug)

export function artifactSlugFromString(value: string): ArtifactSlugType | undefined {
	const decoded = Schema.decodeUnknownOption(ArtifactSlug)(value)
	return Option.isSome(decoded) ? decoded.value : undefined
}

const decodeArtifactKind = Effect.fn(function* decodeArtifactKind(
	toolName: string,
	kind: string | undefined,
) {
	if (kind === undefined || kind.length === 0) return undefined
	return yield* Schema.decodeUnknownEffect(ArtifactKind)(kind).pipe(
		Effect.mapError(() =>
			toolInputError(toolName, 'kind must be scratchpad, document, or generic'),
		),
	)
})

const normalizeTitle = Effect.fn(function* normalizeTitle(title: string | undefined) {
	if (title === undefined) return undefined
	const trimmed = title.trim()
	if (trimmed.length === 0) return undefined
	if (trimmed.length > MAX_TITLE_LENGTH) {
		return yield* toolInputError(
			'artifact_create',
			`title must be ${MAX_TITLE_LENGTH} characters or fewer`,
		)
	}
	return trimmed
})

function defaultTemplateForKind(kind: ArtifactKindType | undefined): string | undefined {
	return kind === 'document' ? DEFAULT_DOCUMENT_TEMPLATE : undefined
}

function slugifyTitle(title: string | undefined, fallback: ArtifactKindType): string {
	const source = title ?? fallback
	const slug = source
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-+|-+$/gu, '')
		.slice(0, 72)
		.replace(/-+$/u, '')
	return slug.length === 0 ? fallback : slug
}

export function generatedArtifactSlug(
	kind: ArtifactKindType,
	title: string | undefined,
): ArtifactSlugType {
	const date = new Date().toISOString().slice(0, 10)
	const random = randomBytes(3).toString('hex')
	return decodeArtifactSlugSync(`${date}-${random}-${slugifyTitle(title, kind)}`)
}

export function artifactsRoot(worktree: string): string {
	return path.resolve(worktree, LIMITLESS_DIRECTORY, ARTIFACTS_DIRECTORY)
}

export function artifactRelativePath(
	slug: ArtifactSlugType,
	...segments: ReadonlyArray<string>
): string {
	return path.posix.join(ARTIFACTS_RELATIVE_DIRECTORY, slug, ...segments)
}

export function artifactDirectoryPath(worktree: string, slug: ArtifactSlugType): string {
	return path.resolve(worktree, artifactRelativePath(slug))
}

export function artifactManifestRelativePath(slug: ArtifactSlugType): string {
	return artifactRelativePath(slug, 'manifest.json')
}

export function artifactManifestPath(worktree: string, slug: ArtifactSlugType): string {
	return path.resolve(worktree, artifactManifestRelativePath(slug))
}

export const ensureArtifactsRoot = Effect.fn(function* ensureArtifactsRoot(
	worktree: string,
	create: boolean,
	toolName: string,
) {
	const limitlessRoot = path.resolve(worktree, LIMITLESS_DIRECTORY)
	const limitlessExists = yield* ensureDirectory(
		limitlessRoot,
		create,
		toolName,
		'Could not inspect artifact directory',
	)
	if (!limitlessExists) return undefined

	const root = artifactsRoot(worktree)
	const artifactsExists = yield* ensureDirectory(
		root,
		create,
		toolName,
		'Could not inspect artifact directory',
	)
	return artifactsExists ? root : undefined
})

export const readArtifactManifest = Effect.fn(function* readArtifactManifest(
	worktree: string,
	slug: ArtifactSlugType,
	toolName: string,
) {
	const manifest = yield* readJsonFile(
		artifactManifestPath(worktree, slug),
		ArtifactManifestSchema,
		toolName,
		'artifact manifest',
	)
	if (manifest.slug !== slug) {
		return yield* toolInputError(toolName, 'Artifact manifest slug mismatch')
	}
	return manifest
})

const createArtifactDirectory = Effect.fn(function* createArtifactDirectory(
	root: string,
	slug: ArtifactSlugType,
	generated: boolean,
) {
	return yield* Effect.tryPromise({
		try: async () => {
			try {
				await mkdir(path.join(root, slug))
				return true
			} catch (error) {
				if (isAlreadyExists(error) && generated) return false
				throw error
			}
		},
		catch: (error) =>
			toolOperationError('artifact_create', 'Could not create artifact workspace', error),
	})
})

function createManifest(
	input: {
		readonly kind: ArtifactKindType
		readonly slug: ArtifactSlugType
		readonly title?: string | undefined
		readonly template?: ArtifactTemplateName | undefined
	},
	context: ToolContext,
): ArtifactManifest {
	return {
		slug: input.slug,
		kind: input.kind,
		createdAt: new Date().toISOString(),
		...optionalField('title', input.title),
		...optionalField('template', input.template),
		createdBy: {
			sessionID: context.sessionID,
			agent: context.agent,
		},
	}
}

export const artifactCreate = Effect.fn(function* artifactCreate(
	input: ArtifactCreateInput,
	context: ToolContext,
) {
	const requestedKind = yield* decodeArtifactKind('artifact_create', input.kind)
	const title = yield* normalizeTitle(input.title)
	const templateName = input.template ?? defaultTemplateForKind(requestedKind)
	const template =
		templateName !== undefined
			? yield* resolveArtifactTemplate(templateName, 'artifact_create')
			: undefined

	if (
		requestedKind !== undefined &&
		template?.manifest.kind !== undefined &&
		template.manifest.kind !== requestedKind
	) {
		return yield* toolInputError(
			'artifact_create',
			`template ${template.manifest.name} creates ${template.manifest.kind} artifacts, not ${requestedKind}`,
		)
	}

	const kind = requestedKind ?? template?.manifest.kind ?? 'scratchpad'
	const root = yield* ensureArtifactsRoot(context.worktree, true, 'artifact_create')
	if (root === undefined) {
		return yield* toolInputError('artifact_create', 'Could not create artifacts root')
	}

	const generated = input.slug === undefined
	let slug = input.slug ?? generatedArtifactSlug(kind, title)
	let created = yield* createArtifactDirectory(root, slug, generated)
	for (let attempt = 0; !created && attempt < 5; attempt += 1) {
		slug = generatedArtifactSlug(kind, title)
		created = yield* createArtifactDirectory(root, slug, true)
	}
	if (!created) {
		return yield* toolInputError('artifact_create', 'Could not allocate a unique artifact slug')
	}

	const directory = path.join(root, slug)
	const manifest = createManifest({ kind, slug, title, template: template?.manifest.name }, context)
	yield* writeJsonFile(path.join(directory, 'manifest.json'), manifest, 'artifact_create')
	if (template !== undefined) {
		if (template.frameworkDirectory !== undefined) {
			yield* copyDirectoryContents(template.frameworkDirectory, directory, 'artifact_create')
		}
		yield* copyDirectoryContents(template.directory, directory, 'artifact_create', [
			TEMPLATE_MANIFEST_FILE,
		])
	} else if (manifest.kind === 'scratchpad') {
		yield* writeNewFile(path.join(directory, 'scratch.md'), '', 'artifact_create')
	}

	return {
		ok: true,
		slug,
		path: artifactRelativePath(slug),
		manifestPath: artifactManifestRelativePath(slug),
		created: true,
		manifest,
	} satisfies ArtifactCreateResult
})

function manifestListEntry(manifest: ArtifactManifest): ArtifactListEntry {
	return {
		slug: manifest.slug,
		kind: manifest.kind,
		path: artifactRelativePath(manifest.slug),
		createdAt: manifest.createdAt,
		...optionalField('title', manifest.title),
		...optionalField('template', manifest.template),
	}
}

const readArtifactsDirectory = Effect.fn(function* readArtifactsDirectory(root: string) {
	return yield* Effect.tryPromise({
		try: () => readdir(root, { withFileTypes: true }),
		catch: (error) => toolOperationError('artifact_list', 'Could not list artifacts', error),
	})
})

function matchesFilters(
	manifest: ArtifactManifest,
	filters: { readonly kind?: ArtifactKindType | undefined; readonly template?: string | undefined },
): boolean {
	if (filters.kind !== undefined && manifest.kind !== filters.kind) return false
	if (filters.template !== undefined && manifest.template !== filters.template) return false
	return true
}

export const artifactList = Effect.fn(function* artifactList(
	input: ArtifactListInput,
	context: ToolContext,
) {
	const kind = yield* decodeArtifactKind('artifact_list', input.kind)
	const root = yield* ensureArtifactsRoot(context.worktree, false, 'artifact_list')
	if (root === undefined) return { ok: true, artifacts: [] }

	const entries = yield* readArtifactsDirectory(root)
	const artifacts: Array<ArtifactListEntry> = []
	const invalidArtifacts: Array<InvalidArtifactListEntry> = []

	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const slug = artifactSlugFromString(entry.name)
		if (slug === undefined) continue

		const manifest = yield* readArtifactManifest(context.worktree, slug, 'artifact_list').pipe(
			Effect.match({
				onFailure: () => ({ ok: false as const }),
				onSuccess: (value) => ({ ok: true as const, value }),
			}),
		)
		if (!manifest.ok) {
			invalidArtifacts.push({
				slug,
				reason: 'manifest.json is missing or invalid',
			})
			continue
		}

		if (matchesFilters(manifest.value, { kind, template: input.template })) {
			artifacts.push(manifestListEntry(manifest.value))
		}
	}

	artifacts.sort((left, right) => {
		const created = right.createdAt.localeCompare(left.createdAt)
		return created === 0 ? left.slug.localeCompare(right.slug) : created
	})

	return {
		ok: true,
		artifacts,
		...optionalField(
			'invalidArtifacts',
			invalidArtifacts.length > 0 ? invalidArtifacts : undefined,
		),
	} satisfies ArtifactListResult
})
