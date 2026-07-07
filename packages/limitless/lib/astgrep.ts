import { Schema } from 'effect'

export const AstGrepSearchInput = Schema.Struct({
	pattern: Schema.String,
	lang: Schema.optional(Schema.String),
	language: Schema.optional(Schema.String),
	paths: Schema.optional(Schema.Array(Schema.String)),
	workspace: Schema.optional(Schema.String),
	json: Schema.optional(Schema.Boolean),
	timeoutMs: Schema.optional(Schema.Finite),
})
export type AstGrepSearchInput = typeof AstGrepSearchInput.Type

export const AstGrepReplaceInput = Schema.Struct({
	pattern: Schema.String,
	rewrite: Schema.String,
	lang: Schema.optional(Schema.String),
	language: Schema.optional(Schema.String),
	paths: Schema.optional(Schema.Array(Schema.String)),
	workspace: Schema.optional(Schema.String),
	dryRun: Schema.optional(Schema.Boolean),
	timeoutMs: Schema.optional(Schema.Finite),
})
export type AstGrepReplaceInput = typeof AstGrepReplaceInput.Type
