import { Schema } from 'effect'

const ARTIFACT_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

function pathSegmentFilter(label: string) {
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

export const ArtifactFileName = Schema.String.check(pathSegmentFilter('file name')).pipe(
	Schema.brand('ArtifactFileName'),
)
export type ArtifactFileName = typeof ArtifactFileName.Type

export const TypstEntryFile = ArtifactFileName.check(
	Schema.makeFilter((value) => value.endsWith('.typ') || 'entry must be a .typ file'),
).pipe(Schema.brand('TypstEntryFile'))
export type TypstEntryFile = typeof TypstEntryFile.Type

export const ArtifactKind = Schema.Union([
	Schema.Literal('scratchpad'),
	Schema.Literal('document'),
	Schema.Literal('generic'),
])
export type ArtifactKind = typeof ArtifactKind.Type

export const ArtifactCreator = Schema.Struct({
	sessionID: Schema.String,
	agent: Schema.String,
})
export type ArtifactCreator = typeof ArtifactCreator.Type

export const ArtifactManifest = Schema.Struct({
	slug: ArtifactSlug,
	kind: ArtifactKind,
	createdAt: Schema.String,
	title: Schema.optional(Schema.String),
	template: Schema.optional(Schema.String),
	createdBy: Schema.optional(ArtifactCreator),
})
export type ArtifactManifest = typeof ArtifactManifest.Type

export const ArtifactCreateInput = Schema.Struct({
	kind: Schema.optional(Schema.String),
	title: Schema.optional(Schema.String),
	slug: Schema.optional(ArtifactSlug),
	template: Schema.optional(Schema.String),
})
export type ArtifactCreateInput = typeof ArtifactCreateInput.Type

export const ArtifactCreateResult = Schema.Struct({
	ok: Schema.Literal(true),
	slug: ArtifactSlug,
	path: Schema.String,
	manifestPath: Schema.String,
	created: Schema.Literal(true),
	manifest: ArtifactManifest,
})
export type ArtifactCreateResult = typeof ArtifactCreateResult.Type

export const ArtifactListInput = Schema.Struct({
	kind: Schema.optional(Schema.String),
	template: Schema.optional(Schema.String),
})
export type ArtifactListInput = typeof ArtifactListInput.Type

export const ArtifactListEntry = Schema.Struct({
	slug: ArtifactSlug,
	kind: ArtifactKind,
	path: Schema.String,
	createdAt: Schema.String,
	title: Schema.optional(Schema.String),
	template: Schema.optional(Schema.String),
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

export const TypstTemplate = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	defaultEntry: Schema.String,
	files: Schema.Array(Schema.String),
	authoring: Schema.String,
	dataShape: Schema.Record(Schema.String, Schema.Unknown),
})
export type TypstTemplate = typeof TypstTemplate.Type

export const TypstTemplatesListInput = Schema.Struct({})
export type TypstTemplatesListInput = typeof TypstTemplatesListInput.Type

export const TypstTemplatesListResult = Schema.Struct({
	ok: Schema.Literal(true),
	templates: Schema.Array(TypstTemplate),
})
export type TypstTemplatesListResult = typeof TypstTemplatesListResult.Type

export const TypstFormat = Schema.Literal('pdf')
export type TypstFormat = typeof TypstFormat.Type

export const TypstCompileInput = Schema.Struct({
	artifact: ArtifactSlug,
	entry: Schema.optional(TypstEntryFile),
	format: Schema.optional(Schema.String),
	timeoutMs: Schema.optional(Schema.Finite),
})
export type TypstCompileInput = typeof TypstCompileInput.Type

export const TypstCompileOptions = Schema.Struct({
	typstBin: Schema.optional(Schema.String),
})
export type TypstCompileOptions = typeof TypstCompileOptions.Type

export const TypstCompileResult = Schema.Struct({
	ok: Schema.Boolean,
	artifact: Schema.String,
	entry: Schema.String,
	format: TypstFormat,
	outputPath: Schema.String,
	command: Schema.String,
	exitCode: Schema.NullOr(Schema.Number),
	signal: Schema.optional(Schema.NullOr(Schema.String)),
	stdout: Schema.String,
	stderr: Schema.String,
})
export type TypstCompileResult = typeof TypstCompileResult.Type
