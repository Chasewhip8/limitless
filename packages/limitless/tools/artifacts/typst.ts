import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { ToolContext } from '@opencode-ai/plugin'
import { Effect, Schema } from 'effect'
import {
	CommandResult,
	DEFAULT_TIMEOUT_MS,
	PositiveFiniteTimeout,
	runCommand,
} from '../../core/command'
import { isMissingPath, toolInputError, toolOperationError } from '../../core/errors'
import { optionalField } from '../../lib/type-utils'
import { ensureDirectory, ensureRegularFile } from './filesystem'
import { artifactDirectoryPath, artifactRelativePath, readArtifactManifest } from './paths'
import { ArtifactFileName, ArtifactSlug } from './schema'

export const TypstEntryFile = ArtifactFileName.check(
	Schema.makeFilter((value) => value.endsWith('.typ') || 'entry must be a .typ file'),
).pipe(Schema.brand('TypstEntryFile'))
export const TypstFormat = Schema.Literal('pdf')
export const TypstCompileInput = Schema.Struct({
	artifact: ArtifactSlug,
	entry: Schema.optional(TypstEntryFile),
	format: Schema.optional(TypstFormat),
	timeoutMs: Schema.optional(PositiveFiniteTimeout),
})
export type TypstCompileInput = typeof TypstCompileInput.Type
export const TypstCompileOptions = Schema.Struct({
	typstBin: Schema.optional(Schema.NonEmptyString),
})
export type TypstCompileOptions = typeof TypstCompileOptions.Type
export const TypstCompileResult = Schema.Struct({
	...CommandResult.fields,
	artifact: ArtifactSlug,
	entry: TypstEntryFile,
	format: TypstFormat,
	outputPath: Schema.String,
	command: Schema.String,
})
export type TypstCompileResult = typeof TypstCompileResult.Type

export const TYPST_BIN = '@TYPST_BIN@'

const decodeToolValue = Effect.fn(function* decodeToolValue<Decoded>(
	toolName: string,
	schema: Schema.Decoder<Decoded>,
	value: unknown,
	message: string,
) {
	return yield* Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError(() => toolInputError(toolName, message)),
	)
})

const normalizeEntry = Effect.fn(function* normalizeEntry(entry: TypstCompileInput['entry']) {
	return yield* decodeToolValue(
		'typst_compile',
		TypstEntryFile,
		entry ?? 'main.typ',
		'entry must be a .typ file in the artifact root',
	)
})

const ensureArtifactDirectory = Effect.fn(function* ensureArtifactDirectory(
	worktree: string,
	slug: TypstCompileInput['artifact'],
) {
	const directory = artifactDirectoryPath(worktree, slug)
	const info = yield* Effect.tryPromise({
		try: () => lstat(directory),
		catch: (error) =>
			toolOperationError('typst_compile', 'Could not inspect artifact workspace', error),
	})
	if (!info.isDirectory()) {
		return yield* toolOperationError(
			'typst_compile',
			'Could not inspect artifact workspace',
			new Error('Artifact path is not a regular directory'),
		)
	}
	return directory
})

const ensureOutputPath = Effect.fn(function* ensureOutputPath(outputPath: string) {
	const outputInfo = yield* Effect.tryPromise({
		try: () => lstat(outputPath),
		catch: (error) => toolOperationError('typst_compile', 'Could not inspect Typst output', error),
	}).pipe(
		Effect.matchEffect({
			onFailure: (error) => (isMissingPath(error) ? Effect.void : Effect.fail(error)),
			onSuccess: Effect.succeed,
		}),
	)
	if (outputInfo !== undefined && !outputInfo.isFile()) {
		return yield* toolOperationError(
			'typst_compile',
			'Could not inspect Typst output',
			new Error('Typst output path exists and is not a regular file'),
		)
	}
})

export const typstCompile = Effect.fn(function* typstCompile(
	input: TypstCompileInput,
	context: ToolContext,
	options: TypstCompileOptions = {},
) {
	const format = input.format ?? TypstFormat.make('pdf')
	const entry = yield* normalizeEntry(input.entry)

	const manifest = yield* readArtifactManifest(context.worktree, input.artifact, 'typst_compile')
	const directory = yield* ensureArtifactDirectory(context.worktree, input.artifact)
	yield* ensureRegularFile(
		path.join(directory, entry),
		'Typst entry file does not exist',
		'typst_compile',
	)
	yield* ensureDirectory(
		path.join(directory, 'dist'),
		true,
		'typst_compile',
		'Could not inspect Typst dist directory',
	)
	const fontDirectory = path.join(directory, 'assets', 'fonts')
	const hasFontDirectory = yield* ensureDirectory(
		fontDirectory,
		false,
		'typst_compile',
		'Could not inspect Typst font directory',
	)

	const outputFile = `${manifest.slug}.pdf`
	const outputRelative = path.posix.join('dist', outputFile)
	const outputPath = path.join(directory, outputRelative)
	yield* ensureOutputPath(outputPath)

	const args = [
		'compile',
		...(hasFontDirectory ? ['--font-path', fontDirectory] : []),
		'--root',
		directory,
		entry,
		outputRelative,
	]
	const result = yield* runCommand(options.typstBin ?? TYPST_BIN, args, {
		cwd: directory,
		timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	})

	return TypstCompileResult.make({
		ok: result.ok,
		artifact: manifest.slug,
		entry,
		format,
		outputPath: artifactRelativePath(manifest.slug, outputRelative),
		command: 'typst compile',
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		...optionalField('signal', result.signal),
	})
})
