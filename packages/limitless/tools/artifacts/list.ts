import { readdir } from 'node:fs/promises'
import { Effect, Option, Result, Schema } from 'effect'
import { isMissingPath, toolOperationError } from '../../core/errors'
import { ToolExecutionContext } from '../../core/execution'
import { optionalField } from '../../lib/type-utils'
import { artifactRelativePath, ensureArtifactsRoot, readArtifactManifest } from './paths'
import {
	type ArtifactManifest,
	ArtifactSlug,
	ArtifactTemplateReference,
	ArtifactTimestamp,
	ArtifactTitle,
} from './schema'

export const ArtifactListInput = Schema.Struct({
	template: Schema.optional(ArtifactTemplateReference),
})
export type ArtifactListInput = typeof ArtifactListInput.Type

export const ArtifactListEntry = Schema.Struct({
	slug: ArtifactSlug,
	path: Schema.String,
	createdAt: ArtifactTimestamp,
	title: Schema.optional(ArtifactTitle),
	template: Schema.optional(ArtifactTemplateReference),
})
export type ArtifactListEntry = typeof ArtifactListEntry.Type

export const InvalidArtifactListEntry = Schema.Struct({
	slug: ArtifactSlug,
	reason: Schema.String,
})
export type InvalidArtifactListEntry = typeof InvalidArtifactListEntry.Type

export const ArtifactListResult = Schema.Struct({
	ok: Schema.Literal(true),
	artifacts: Schema.Array(ArtifactListEntry),
	invalidArtifacts: Schema.optional(Schema.Array(InvalidArtifactListEntry)),
})
export type ArtifactListResult = typeof ArtifactListResult.Type

export function artifactSlugFromString(value: string): typeof ArtifactSlug.Type | undefined {
	const decoded = Schema.decodeUnknownOption(ArtifactSlug)(value)
	return Option.isSome(decoded) ? decoded.value : undefined
}

function manifestListEntry(manifest: typeof ArtifactManifest.Type): typeof ArtifactListEntry.Type {
	return ArtifactListEntry.make({
		slug: manifest.slug,
		path: artifactRelativePath(manifest.slug),
		createdAt: manifest.createdAt,
		...optionalField('title', manifest.title),
		...optionalField('template', manifest.template),
	})
}

const readArtifactsDirectory = Effect.fn(function* readArtifactsDirectory(root: string) {
	return yield* Effect.tryPromise({
		try: () => readdir(root, { withFileTypes: true }),
		catch: (error) => toolOperationError('artifact_list', 'Could not list artifacts', error),
	})
})

export const artifactList = Effect.fn(function* artifactList(input: ArtifactListInput) {
	const context = yield* ToolExecutionContext
	const root = yield* ensureArtifactsRoot(context.projectRoot, false, 'artifact_list')
	if (root === undefined) return ArtifactListResult.make({ ok: true, artifacts: [] })
	const entries = yield* readArtifactsDirectory(root)
	const artifacts: Array<ArtifactListEntry> = []
	const invalidArtifacts: Array<InvalidArtifactListEntry> = []
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const slug = artifactSlugFromString(entry.name)
		if (slug === undefined) continue
		const manifest = yield* Effect.result(
			readArtifactManifest(context.projectRoot, slug, 'artifact_list'),
		)
		if (Result.isFailure(manifest)) {
			if (manifest.failure._tag !== 'ToolInputError' && !isMissingPath(manifest.failure)) {
				return yield* manifest.failure
			}
			invalidArtifacts.push({ slug, reason: 'manifest.json is missing or invalid' })
			continue
		}
		if (input.template === undefined || manifest.success.template === input.template) {
			artifacts.push(manifestListEntry(manifest.success))
		}
	}
	artifacts.sort((left, right) => {
		const created = right.createdAt.localeCompare(left.createdAt)
		return created === 0 ? left.slug.localeCompare(right.slug) : created
	})
	return ArtifactListResult.make({
		ok: true,
		artifacts,
		...optionalField(
			'invalidArtifacts',
			invalidArtifacts.length > 0 ? invalidArtifacts : undefined,
		),
	})
})
