import { readdir } from 'node:fs/promises'
import type { ToolContext } from '@opencode-ai/plugin'
import { Effect } from 'effect'
import { artifactOperationError, decodeToolValue } from './errors'
import { ensureArtifactsRoot, readArtifactManifest } from './files'
import { artifactRelativePath, artifactSlugFromString } from './paths'
import {
	ArtifactKind,
	type ArtifactKind as ArtifactKindType,
	type ArtifactListEntry,
	type ArtifactListInput,
	type ArtifactListResult,
	type ArtifactManifest,
	type InvalidArtifactListEntry,
} from './schemas'

const normalizeKind = Effect.fn(function* normalizeKind(kind: string | undefined) {
	if (kind === undefined || kind.length === 0) return undefined
	return yield* decodeToolValue(
		'artifact_list',
		ArtifactKind,
		kind,
		'kind must be scratchpad, document, or generic',
	)
})

function manifestListEntry(manifest: ArtifactManifest): ArtifactListEntry {
	return {
		slug: manifest.slug,
		kind: manifest.kind,
		path: artifactRelativePath(manifest.slug),
		createdAt: manifest.createdAt,
		...(manifest.title !== undefined ? { title: manifest.title } : {}),
		...(manifest.template !== undefined ? { template: manifest.template } : {}),
	}
}

const readArtifactsDirectory = Effect.fn(function* readArtifactsDirectory(root: string) {
	return yield* Effect.tryPromise({
		try: () => readdir(root, { withFileTypes: true }),
		catch: (error) => artifactOperationError('artifact_list', 'Could not list artifacts', error),
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
	const kind = yield* normalizeKind(input.kind)
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
		...(invalidArtifacts.length > 0 ? { invalidArtifacts } : {}),
	} satisfies ArtifactListResult
})
