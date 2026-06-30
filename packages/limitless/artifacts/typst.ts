import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { ToolContext } from '@opencode-ai/plugin'
import { Effect } from 'effect'
import { DEFAULT_TIMEOUT_MS, runCommand } from '../shared'
import { artifactOperationError, decodeToolValue, isMissingPath } from './errors'
import {
	ensureArtifactDirectory,
	ensureDirectory,
	ensureRegularFile,
	readArtifactManifest,
} from './files'
import { artifactRelativePath } from './paths'
import {
	type TypstCompileInput,
	type TypstCompileOptions,
	type TypstCompileResult,
	TypstEntryFile,
	TypstFormat,
} from './schemas'

export const TYPST_BIN = '@TYPST_BIN@'

const normalizeFormat = Effect.fn(function* normalizeFormat(format: string | undefined) {
	return yield* decodeToolValue('typst_compile', TypstFormat, format ?? 'pdf', 'format must be pdf')
})

const normalizeEntry = Effect.fn(function* normalizeEntry(entry: TypstCompileInput['entry']) {
	return yield* decodeToolValue(
		'typst_compile',
		TypstEntryFile,
		entry ?? 'main.typ',
		'entry must be a .typ file in the artifact root',
	)
})

const ensureOutputPath = Effect.fn(function* ensureOutputPath(outputPath: string) {
	return yield* Effect.tryPromise({
		try: async () => {
			try {
				const outputInfo = await lstat(outputPath)
				if (!outputInfo.isFile())
					throw new Error('Typst output path exists and is not a regular file')
			} catch (error) {
				if (!isMissingPath(error)) throw error
			}
		},
		catch: (error) =>
			artifactOperationError('typst_compile', 'Could not inspect Typst output', error),
	})
})

export const typstCompile = Effect.fn(function* typstCompile(
	input: TypstCompileInput,
	context: ToolContext,
	options: TypstCompileOptions = {},
) {
	const format = yield* normalizeFormat(input.format)
	const entry = yield* normalizeEntry(input.entry)

	const manifest = yield* readArtifactManifest(context.worktree, input.artifact, 'typst_compile')
	const directory = yield* ensureArtifactDirectory(
		context.worktree,
		input.artifact,
		'typst_compile',
	)
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

	const outputFile = `${manifest.slug}.pdf`
	const outputRelative = path.posix.join('dist', outputFile)
	const outputPath = path.join(directory, outputRelative)
	yield* ensureOutputPath(outputPath)

	const args = ['compile', '--root', directory, entry, outputRelative]
	const result = yield* runCommand(options.typstBin ?? TYPST_BIN, args, {
		cwd: directory,
		timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	})

	return {
		ok: result.ok,
		artifact: manifest.slug,
		entry,
		format,
		outputPath: artifactRelativePath(manifest.slug, outputRelative),
		command: 'typst compile',
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		...(result.signal !== undefined ? { signal: result.signal } : {}),
	} satisfies TypstCompileResult
})
