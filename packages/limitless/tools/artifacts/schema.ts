import { Schema } from 'effect'

const ARTIFACT_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
export const ARTIFACT_TITLE_MAX_LENGTH = 160

export function pathSegmentFilter(label: string) {
	return Schema.makeFilter<string>((value) => {
		if (value.length === 0) return `${label} is required`
		if (value === '.' || value === '..') return `${label} must be a single path segment`
		if (!ARTIFACT_PATH_SEGMENT_PATTERN.test(value)) {
			return `${label} must be 1-128 characters and contain only letters, numbers, dot, underscore, or hyphen`
		}
		return true
	})
}

export const ArtifactSlug = Schema.String.check(pathSegmentFilter('slug')).pipe(
	Schema.brand('ArtifactSlug'),
)
export type ArtifactSlug = typeof ArtifactSlug.Type

export const ArtifactTitle = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(ARTIFACT_TITLE_MAX_LENGTH),
).pipe(Schema.brand('ArtifactTitle'))
export type ArtifactTitle = typeof ArtifactTitle.Type

export const ArtifactTimestamp = Schema.String.check(
	Schema.makeFilter((value) => {
		const date = new Date(value)
		return (
			(!Number.isNaN(date.getTime()) && date.toISOString() === value) ||
			'createdAt must be an ISO 8601 UTC timestamp'
		)
	}),
).pipe(Schema.brand('ArtifactTimestamp'))
export type ArtifactTimestamp = typeof ArtifactTimestamp.Type

export const Artifact = Schema.Struct({
	slug: ArtifactSlug,
	path: Schema.String,
	title: Schema.optional(ArtifactTitle),
	createdAt: ArtifactTimestamp,
})
export type Artifact = typeof Artifact.Type

export const ArtifactCreator = Schema.Struct({
	sessionID: Schema.String,
	agent: Schema.String,
})
export type ArtifactCreator = typeof ArtifactCreator.Type

export const ArtifactManifest = Schema.Struct({
	slug: ArtifactSlug,
	createdAt: ArtifactTimestamp,
	title: Schema.optional(ArtifactTitle),
	createdBy: Schema.optional(ArtifactCreator),
})
export type ArtifactManifest = typeof ArtifactManifest.Type
