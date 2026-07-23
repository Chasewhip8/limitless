import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { Effect, Schema } from 'effect'
import { isAlreadyExists, toolInputError, toolOperationError } from '../../core/errors'
import { ToolExecutionContext } from '../../core/execution'
import { optionalField } from '../../lib/type-utils'
import { copyDirectoryContents, writeJsonFile } from './filesystem'
import { artifactManifestRelativePath, artifactRelativePath, ensureArtifactsRoot } from './paths'
import type { ArtifactTemplateName } from './schema'
import {
	ARTIFACT_TITLE_MAX_LENGTH,
	ArtifactManifest as ArtifactManifestSchema,
	ArtifactSlug,
	type ArtifactSlug as ArtifactSlugType,
	ArtifactTemplateReference,
	ArtifactTimestamp,
	ArtifactTitle,
} from './schema'
import { resolveArtifactTemplate } from './templates'

const ArtifactTitleInput = Schema.String.check(
	Schema.makeFilter(
		(value) =>
			value.trim().length <= ARTIFACT_TITLE_MAX_LENGTH ||
			`title must be ${ARTIFACT_TITLE_MAX_LENGTH} characters or fewer`,
	),
)

export const ArtifactCreateInput = Schema.Struct({
	title: Schema.optional(ArtifactTitleInput),
	slug: Schema.optional(ArtifactSlug),
	template: Schema.optional(ArtifactTemplateReference),
})
export type ArtifactCreateInput = typeof ArtifactCreateInput.Type

export const ArtifactCreateResult = Schema.Struct({
	ok: Schema.Literal(true),
	slug: ArtifactSlug,
	path: Schema.String,
	manifestPath: Schema.String,
	created: Schema.Literal(true),
	manifest: ArtifactManifestSchema,
})
export type ArtifactCreateResult = typeof ArtifactCreateResult.Type

const TEMPLATE_MANIFEST_FILE = 'manifest.json'
export const decodeArtifactSlug = Schema.decodeUnknownEffect(ArtifactSlug)

const normalizeTitle = Effect.fn(function* normalizeTitle(title: string | undefined) {
	if (title === undefined) return undefined
	const trimmed = title.trim()
	if (trimmed.length === 0) return undefined
	return yield* Schema.decodeUnknownEffect(ArtifactTitle)(trimmed).pipe(
		Effect.mapError(() =>
			toolInputError(
				'artifact_create',
				`title must be ${ARTIFACT_TITLE_MAX_LENGTH} characters or fewer`,
			),
		),
	)
})

function slugifyTitle(title: string | undefined, fallback: string): string {
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

export const generatedArtifactSlug = Effect.fn(function* generatedArtifactSlug(
	fallback: string,
	title: string | undefined,
) {
	const value = yield* Effect.try({
		try: () => {
			const date = new Date().toISOString().slice(0, 10)
			const random = randomBytes(3).toString('hex')
			return `${date}-${random}-${slugifyTitle(title, fallback)}`
		},
		catch: (error) =>
			toolOperationError('artifact_create', 'Could not generate artifact slug', error),
	})
	return yield* Schema.decodeUnknownEffect(ArtifactSlug)(value).pipe(
		Effect.mapError((error) =>
			toolOperationError('artifact_create', 'Could not generate artifact slug', error),
		),
	)
})

const createArtifactDirectory = Effect.fn(function* createArtifactDirectory(
	root: string,
	slug: ArtifactSlugType,
	generated: boolean,
) {
	return yield* Effect.tryPromise({
		try: () => mkdir(path.join(root, slug)),
		catch: (error) =>
			toolOperationError('artifact_create', 'Could not create artifact workspace', error),
	}).pipe(
		Effect.matchEffect({
			onFailure: (error) =>
				isAlreadyExists(error) && generated ? Effect.succeed(false) : Effect.fail(error),
			onSuccess: () => Effect.succeed(true),
		}),
	)
})

const createManifest = Effect.fn(function* createManifest(
	slug: ArtifactSlugType,
	title: typeof ArtifactTitle.Type | undefined,
	template: ArtifactTemplateName | undefined,
) {
	const context = yield* ToolExecutionContext
	const timestamp = yield* Effect.try({
		try: () => new Date().toISOString(),
		catch: (error) =>
			toolOperationError('artifact_create', 'Could not generate artifact timestamp', error),
	})
	const createdAt = yield* Schema.decodeUnknownEffect(ArtifactTimestamp)(timestamp).pipe(
		Effect.mapError((error) =>
			toolOperationError('artifact_create', 'Could not generate artifact timestamp', error),
		),
	)
	return ArtifactManifestSchema.make({
		slug,
		createdAt,
		...optionalField('title', title),
		...optionalField('template', template),
		createdBy: {
			sessionID: context.sessionId,
			agent: context.agent,
		},
	})
})

export const artifactCreate = Effect.fn(function* artifactCreate(input: ArtifactCreateInput) {
	const context = yield* ToolExecutionContext
	const title = yield* normalizeTitle(input.title)
	const templateName = input.template
	const template =
		templateName !== undefined
			? yield* resolveArtifactTemplate(templateName, 'artifact_create')
			: undefined
	const root = yield* ensureArtifactsRoot(context.projectRoot, true, 'artifact_create')
	if (root === undefined) {
		return yield* toolInputError('artifact_create', 'Could not create artifacts root')
	}

	const generated = input.slug === undefined
	const slugFallback = template?.manifest.title ?? template?.manifest.name ?? 'artifact'
	let slug = input.slug ?? (yield* generatedArtifactSlug(slugFallback, title))
	let created = yield* createArtifactDirectory(root, slug, generated)
	for (let attempt = 0; !created && attempt < 5; attempt += 1) {
		slug = yield* generatedArtifactSlug(slugFallback, title)
		created = yield* createArtifactDirectory(root, slug, true)
	}
	if (!created) {
		return yield* toolInputError('artifact_create', 'Could not allocate a unique artifact slug')
	}

	const directory = path.join(root, slug)
	const manifest = yield* createManifest(slug, title, template?.manifest.name)
	yield* writeJsonFile(path.join(directory, 'manifest.json'), manifest, 'artifact_create')
	if (template !== undefined) {
		if (template.frameworkDirectory !== undefined) {
			yield* copyDirectoryContents(template.frameworkDirectory, directory, 'artifact_create')
		}
		yield* copyDirectoryContents(template.directory, directory, 'artifact_create', [
			TEMPLATE_MANIFEST_FILE,
		])
	}

	return ArtifactCreateResult.make({
		ok: true,
		slug,
		path: artifactRelativePath(slug),
		manifestPath: artifactManifestRelativePath(slug),
		created: true,
		manifest,
	})
})
