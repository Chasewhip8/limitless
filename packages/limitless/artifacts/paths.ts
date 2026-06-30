import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { Option, Schema } from 'effect'
import { type ArtifactKind, ArtifactSlug, type ArtifactSlug as ArtifactSlugType } from './schemas'

export const LIMITLESS_DIRECTORY = '.limitless'
export const ARTIFACTS_DIRECTORY = 'artifacts'
export const ARTIFACTS_RELATIVE_DIRECTORY = path.posix.join(
	LIMITLESS_DIRECTORY,
	ARTIFACTS_DIRECTORY,
)

export const decodeArtifactSlugSync = Schema.decodeUnknownSync(ArtifactSlug)

export function artifactSlugFromString(value: string): ArtifactSlugType | undefined {
	const decoded = Schema.decodeUnknownOption(ArtifactSlug)(value)
	return Option.isSome(decoded) ? decoded.value : undefined
}

function slugifyTitle(title: string | undefined, fallback: ArtifactKind): string {
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
	kind: ArtifactKind,
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
