import { Schema } from 'effect'
import { pathSegmentFilter } from './artifact'

export const ArtifactTemplateName = Schema.String.check(pathSegmentFilter('template name')).pipe(
	Schema.brand('ArtifactTemplateName'),
)
export type ArtifactTemplateName = typeof ArtifactTemplateName.Type

export const ArtifactTemplateManifest = Schema.Struct({
	name: ArtifactTemplateName,
	description: Schema.String,
	title: Schema.optional(Schema.String),
	framework: Schema.optional(ArtifactTemplateName),
	authoring: Schema.optional(Schema.String),
})
export type ArtifactTemplateManifest = typeof ArtifactTemplateManifest.Type

export const ArtifactTemplate = Schema.Struct({
	name: ArtifactTemplateName,
	description: Schema.String,
	path: Schema.String,
	files: Schema.Array(Schema.String),
	title: Schema.optional(Schema.String),
	framework: Schema.optional(ArtifactTemplateName),
	authoring: Schema.optional(Schema.String),
})
export type ArtifactTemplate = typeof ArtifactTemplate.Type

export const InvalidArtifactTemplate = Schema.Struct({
	name: Schema.String,
	reason: Schema.String,
})
export type InvalidArtifactTemplate = typeof InvalidArtifactTemplate.Type

export const ArtifactTemplatesListInput = Schema.Struct({})
export type ArtifactTemplatesListInput = typeof ArtifactTemplatesListInput.Type

export const ArtifactTemplatesListResult = Schema.Struct({
	ok: Schema.Literal(true),
	templates: Schema.Array(ArtifactTemplate),
	invalidTemplates: Schema.optional(Schema.Array(InvalidArtifactTemplate)),
})
export type ArtifactTemplatesListResult = typeof ArtifactTemplatesListResult.Type

export const ArtifactTemplateReadInput = Schema.Struct({
	template: Schema.String,
	file: Schema.String,
})
export type ArtifactTemplateReadInput = typeof ArtifactTemplateReadInput.Type

export const ArtifactTemplateReadResult = Schema.Struct({
	ok: Schema.Literal(true),
	template: ArtifactTemplateName,
	file: Schema.String,
	content: Schema.String,
})
export type ArtifactTemplateReadResult = typeof ArtifactTemplateReadResult.Type
