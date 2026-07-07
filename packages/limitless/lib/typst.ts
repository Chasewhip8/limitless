import { Schema } from 'effect'
import { ArtifactFileName, ArtifactSlug } from './artifact'

export const TypstEntryFile = ArtifactFileName.check(
	Schema.makeFilter((value) => value.endsWith('.typ') || 'entry must be a .typ file'),
).pipe(Schema.brand('TypstEntryFile'))
export type TypstEntryFile = typeof TypstEntryFile.Type

export const TypstFormat = Schema.Literal('pdf')
export type TypstFormat = typeof TypstFormat.Type

export const TypstCompileInput = Schema.Struct({
	artifact: ArtifactSlug,
	entry: Schema.optional(TypstEntryFile),
	format: Schema.optional(Schema.String),
	timeoutMs: Schema.optional(Schema.Finite),
})
export type TypstCompileInput = typeof TypstCompileInput.Type

export type TypstCompileOptions = {
	readonly typstBin?: string
}

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
