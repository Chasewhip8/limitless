import { randomBytes } from 'node:crypto'
import { mkdir, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { Effect, Exit, Schema } from 'effect'
import { isAlreadyExists, toolInputError, toolOperationError } from '../../core/errors'
import { ToolExecutionContext } from '../../core/execution'
import { optionalField } from '../../lib/type-utils'
import { writeJsonFile } from './filesystem'
import { artifactFromManifest, ensureArtifactsRoot } from './paths'
import {
	ARTIFACT_TITLE_MAX_LENGTH,
	Artifact,
	ArtifactManifest as ArtifactManifestSchema,
	ArtifactSlug,
	type ArtifactSlug as ArtifactSlugType,
	ArtifactTimestamp,
	ArtifactTitle,
} from './schema'

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
})
export type ArtifactCreateInput = typeof ArtifactCreateInput.Type

export const ArtifactCreateResult = Schema.Struct({
	ok: Schema.Literal(true),
	artifact: Artifact,
})
export type ArtifactCreateResult = typeof ArtifactCreateResult.Type

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

function slugifyTitle(title: string | undefined): string {
	const source = title ?? 'artifact'
	const slug = source
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-+|-+$/gu, '')
		.slice(0, 72)
		.replace(/-+$/u, '')
	return slug.length === 0 ? 'artifact' : slug
}

const generatedArtifactSlug = Effect.fn(function* generatedArtifactSlug(title: string | undefined) {
	const value = yield* Effect.try({
		try: () => {
			const date = new Date().toISOString().slice(0, 10)
			const random = randomBytes(3).toString('hex')
			return `${date}-${random}-${slugifyTitle(title)}`
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
				Effect.gen(function* () {
					if (!isAlreadyExists(error)) return yield* error
					if (generated) return false
					return yield* toolInputError('artifact_create', `Artifact already exists: ${slug}`)
				}),
			onSuccess: () => Effect.succeed(true),
		}),
	)
})

const allocateArtifactDirectory = Effect.fn(function* allocateArtifactDirectory(
	root: string,
	requestedSlug: ArtifactSlugType | undefined,
	title: string | undefined,
) {
	const generated = requestedSlug === undefined
	let slug = requestedSlug ?? (yield* generatedArtifactSlug(title))
	let created = yield* createArtifactDirectory(root, slug, generated)
	for (let attempt = 0; !created && attempt < 5; attempt += 1) {
		slug = yield* generatedArtifactSlug(title)
		created = yield* createArtifactDirectory(root, slug, true)
	}
	if (!created) {
		return yield* toolInputError('artifact_create', 'Could not allocate a unique artifact slug')
	}
	return slug
})

const createManifest = Effect.fn(function* createManifest(
	slug: ArtifactSlugType,
	title: typeof ArtifactTitle.Type | undefined,
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
		createdBy: {
			sessionID: context.sessionId,
			agent: context.agent,
		},
	})
})

export const artifactCreate = Effect.fn(function* artifactCreate(input: ArtifactCreateInput) {
	const context = yield* ToolExecutionContext
	const title = yield* normalizeTitle(input.title)
	const root = yield* ensureArtifactsRoot(context.projectRoot, true, 'artifact_create')
	if (root === undefined) {
		return yield* toolInputError('artifact_create', 'Could not create artifacts root')
	}

	let committed = false
	// Return the creation failure after cleanup so an incomplete rollback is visible.
	const creation = yield* Effect.acquireUseRelease(
		allocateArtifactDirectory(root, input.slug, title),
		(slug) =>
			Effect.gen(function* () {
				const manifest = yield* createManifest(slug, title)
				const result = ArtifactCreateResult.make({
					ok: true,
					artifact: artifactFromManifest(manifest),
				})
				// Finish the small manifest write before cancellation can release the directory.
				return yield* Effect.uninterruptible(
					writeJsonFile(path.join(root, slug, 'manifest.json'), manifest, 'artifact_create').pipe(
						Effect.map(() => {
							committed = true
							return result
						}),
					),
				)
			}).pipe(Effect.exit),
		(slug) =>
			committed
				? Effect.void
				: Effect.tryPromise({
						// Remove only an empty directory so concurrent user files are preserved.
						try: () => rmdir(path.join(root, slug)),
						catch: (error) =>
							toolOperationError(
								'artifact_create',
								`Could not remove incomplete artifact: ${slug}`,
								error,
							),
					}),
	)
	if (Exit.isFailure(creation)) return yield* Effect.failCause(creation.cause)
	return creation.value
})
