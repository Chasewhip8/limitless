import { Schema } from 'effect'

const TEMPLATE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u

export const TemplatePath = Schema.String.check(
	Schema.makeFilter((value) => {
		if (value.length === 0) return 'template path is required'
		if (value.startsWith('/') || value.includes('..')) {
			return 'template path must be relative and stay inside the artifact'
		}
		if (!TEMPLATE_PATH_PATTERN.test(value)) {
			return 'template path must contain only slash-separated letters, numbers, dot, underscore, or hyphen segments'
		}
		return true
	}),
).pipe(Schema.brand('TemplatePath'))
export type TemplatePath = typeof TemplatePath.Type

export const TemplateInstantiationInput = Schema.Struct({
	title: Schema.optional(Schema.String),
})
export type TemplateInstantiationInput = typeof TemplateInstantiationInput.Type

export const TemplateDirectory = Schema.Struct({
	kind: Schema.Literal('directory'),
	path: TemplatePath,
})

export const TemplateTextFile = Schema.Struct({
	kind: Schema.Literal('text'),
	path: TemplatePath,
	content: Schema.String,
})

export const TemplateJsonFile = Schema.Struct({
	kind: Schema.Literal('json'),
	path: TemplatePath,
	value: Schema.Unknown,
})

export const TemplateBinaryFile = Schema.Struct({
	kind: Schema.Literal('binary'),
	path: TemplatePath,
	content: Schema.Uint8Array,
})

export const TemplateArtifactEntry = Schema.Union([
	TemplateDirectory,
	TemplateTextFile,
	TemplateJsonFile,
	TemplateBinaryFile,
])
export type TemplateArtifactEntry = typeof TemplateArtifactEntry.Type

export const decodeTemplatePathSync = Schema.decodeUnknownSync(TemplatePath)
