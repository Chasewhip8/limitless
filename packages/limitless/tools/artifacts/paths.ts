import path from 'node:path'
import { Effect } from 'effect'
import { toolInputError } from '../../core/errors'
import {
	ARTIFACTS_STORAGE_RELATIVE_PATH,
	artifactsStorageRoot,
	limitlessStorageRoot,
} from '../../core/storage'
import { ensureDirectory, readJsonFile } from './filesystem'
import { ArtifactManifest, type ArtifactSlug as ArtifactSlugType } from './schema'

export function artifactsRoot(worktree: string): string {
	return artifactsStorageRoot(worktree)
}

export function artifactRelativePath(
	slug: ArtifactSlugType,
	...segments: ReadonlyArray<string>
): string {
	return path.posix.join(ARTIFACTS_STORAGE_RELATIVE_PATH, slug, ...segments)
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
	const limitlessRoot = limitlessStorageRoot(worktree)
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
		ArtifactManifest,
		toolName,
		'artifact manifest',
	)
	if (manifest.slug !== slug)
		return yield* toolInputError(toolName, 'Artifact manifest slug mismatch')
	return manifest
})
