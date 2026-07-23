import { constants as fsConstants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Effect, Schema } from 'effect'
import {
	isAlreadyExists,
	isMissingPath,
	type ToolInputError,
	type ToolOperationError,
	toolInputError,
	toolOperationError,
} from '../../core/errors'

function operationPromise<Value>(
	toolName: string,
	message: string,
	operation: (signal: AbortSignal) => PromiseLike<Value>,
): Effect.Effect<Value, ToolOperationError> {
	return Effect.tryPromise({
		try: operation,
		catch: (error) => toolOperationError(toolName, message, error),
	})
}

function inspectPath(filePath: string, toolName: string, message: string) {
	return Effect.tryPromise({
		try: () => lstat(filePath),
		catch: (error) => toolOperationError(toolName, message, error),
	})
}

const existingPathInfo = Effect.fn(function* existingPathInfo(
	filePath: string,
	toolName: string,
	message: string,
) {
	return yield* inspectPath(filePath, toolName, message).pipe(
		Effect.matchEffect({
			onFailure: (error) => (isMissingPath(error) ? Effect.void : Effect.fail(error)),
			onSuccess: Effect.succeed,
		}),
	)
})

export const ensureDirectory = Effect.fn(function* ensureDirectory(
	directory: string,
	create: boolean,
	toolName: string,
	message: string,
) {
	const existing = yield* existingPathInfo(directory, toolName, message)
	if (existing !== undefined) {
		if (!existing.isDirectory()) {
			return yield* toolOperationError(
				toolName,
				message,
				new Error('Path is not a regular directory'),
			)
		}
		return true
	}
	if (!create) return false

	yield* Effect.tryPromise({
		try: () => mkdir(directory),
		catch: (error) => toolOperationError(toolName, message, error),
	}).pipe(
		Effect.matchEffect({
			onFailure: (error) => (isAlreadyExists(error) ? Effect.void : Effect.fail(error)),
			onSuccess: () => Effect.void,
		}),
	)

	const created = yield* operationPromise(toolName, message, () => lstat(directory))
	if (!created.isDirectory()) {
		return yield* toolOperationError(
			toolName,
			message,
			new Error('Path is not a regular directory'),
		)
	}
	return true
})

export const writeNewFile = Effect.fn(function* writeNewFile(
	filePath: string,
	content: string,
	toolName: string,
) {
	const message = 'Could not write artifact file'
	let closeFailure: ToolOperationError | undefined
	const writeResult = yield* Effect.scoped(
		Effect.acquireRelease(
			operationPromise(toolName, message, () => open(filePath, 'wx')),
			(handle) =>
				operationPromise(toolName, message, () => handle.close()).pipe(
					Effect.match({
						onFailure: (error) => {
							closeFailure = error
						},
						onSuccess: () => undefined,
					}),
				),
		).pipe(
			Effect.flatMap((handle) =>
				operationPromise(toolName, message, () => handle.writeFile(content, 'utf8')),
			),
			Effect.match({
				onFailure: (error) => ({ ok: false as const, error }),
				onSuccess: () => ({ ok: true as const }),
			}),
		),
	)
	if (closeFailure !== undefined) return yield* closeFailure
	if (!writeResult.ok) return yield* writeResult.error
})

export const writeJsonFile = Effect.fn(function* writeJsonFile(
	filePath: string,
	value: unknown,
	toolName: string,
) {
	const encoded = yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(value).pipe(
		Effect.mapError((error) =>
			toolOperationError(toolName, 'Could not serialize artifact JSON', error),
		),
	)
	const json = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(encoded).pipe(
		Effect.mapError((error) =>
			toolOperationError(toolName, 'Could not serialize artifact JSON', error),
		),
	)
	const content = yield* Effect.try({
		try: () => {
			const pretty = JSON.stringify(json, null, 2)
			if (typeof pretty !== 'string') throw new Error('Artifact value is not JSON serializable')
			return `${pretty}\n`
		},
		catch: (error) => toolOperationError(toolName, 'Could not serialize artifact JSON', error),
	})
	return yield* writeNewFile(filePath, content, toolName)
})

const createExclusiveDirectory = Effect.fn(function* createExclusiveDirectory(
	directory: string,
	toolName: string,
	message: string,
) {
	yield* operationPromise(toolName, message, () => mkdir(directory))
	const info = yield* operationPromise(toolName, message, () => lstat(directory))
	if (!info.isDirectory()) {
		return yield* toolOperationError(
			toolName,
			message,
			new Error('Path is not a regular directory'),
		)
	}
})

function copyDirectoryContentsRecursive(
	source: string,
	destination: string,
	excludeRootEntries: ReadonlyArray<string>,
	baseDirectory: string,
	toolName: string,
): Effect.Effect<void, ToolOperationError | ToolInputError> {
	return Effect.gen(function* () {
		const message = 'Could not copy template files'
		const entries = yield* operationPromise(toolName, message, () =>
			readdir(source, { withFileTypes: true }),
		)

		for (const entry of entries
			.slice()
			.sort((left, right) => left.name.localeCompare(right.name))) {
			if (source === baseDirectory && excludeRootEntries.includes(entry.name)) continue

			const sourcePath = path.join(source, entry.name)
			const destinationPath = path.join(destination, entry.name)
			const relativePath = path
				.relative(baseDirectory, sourcePath)
				.split(path.sep)
				.join(path.posix.sep)
			if (entry.isDirectory()) {
				yield* createExclusiveDirectory(destinationPath, toolName, message)
				yield* copyDirectoryContentsRecursive(
					sourcePath,
					destinationPath,
					excludeRootEntries,
					baseDirectory,
					toolName,
				)
				continue
			}

			if (entry.isFile()) {
				yield* operationPromise(toolName, message, () =>
					copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL),
				)
				const sourceInfo = yield* operationPromise(toolName, message, () => lstat(sourcePath))
				yield* operationPromise(toolName, message, () =>
					chmod(destinationPath, (sourceInfo.mode & 0o777) | 0o200),
				)
				continue
			}

			return yield* toolInputError(
				toolName,
				`Template contains unsupported file type: ${relativePath}`,
			)
		}
	})
}

export const copyDirectoryContents = Effect.fn(function* copyDirectoryContents(
	source: string,
	destination: string,
	toolName: string,
	excludeRootEntries: ReadonlyArray<string> = [],
) {
	return yield* copyDirectoryContentsRecursive(
		source,
		destination,
		excludeRootEntries,
		source,
		toolName,
	)
})

export const ensureRegularFile = Effect.fn(function* ensureRegularFile(
	filePath: string,
	missingMessage: string,
	toolName: string,
) {
	const message = 'Could not inspect artifact file'
	const info = yield* existingPathInfo(filePath, toolName, message)
	if (info === undefined) return yield* toolInputError(toolName, missingMessage)
	if (!info.isFile()) {
		return yield* toolOperationError(toolName, message, new Error('Path is not a regular file'))
	}
})

const readTextFile = Effect.fn(function* readTextFile(
	filePath: string,
	toolName: string,
	message: string,
) {
	return yield* operationPromise(toolName, message, (signal) =>
		readFile(filePath, { encoding: 'utf8', signal }),
	)
})

export const readJsonFile = Effect.fn(function* readJsonFile<Decoded>(
	filePath: string,
	schema: Schema.Decoder<Decoded>,
	toolName: string,
	label: string,
) {
	const content = yield* readTextFile(filePath, toolName, `Could not read ${label}`)
	const parsed = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(content).pipe(
		Effect.mapError(() => toolInputError(toolName, `Invalid ${label} JSON`)),
	)
	return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
		Effect.mapError(() => toolInputError(toolName, `Invalid ${label}`)),
	)
})

function listDirectoryFilesRecursiveFrom(
	directory: string,
	baseDirectory: string,
	excludeRootEntries: ReadonlyArray<string>,
	toolName: string,
): Effect.Effect<Array<string>, ToolOperationError | ToolInputError> {
	return Effect.gen(function* () {
		const message = 'Could not list directory files'
		const entries = yield* operationPromise(toolName, message, () =>
			readdir(directory, { withFileTypes: true }),
		)
		const files: Array<string> = []

		for (const entry of entries
			.slice()
			.sort((left, right) => left.name.localeCompare(right.name))) {
			if (directory === baseDirectory && excludeRootEntries.includes(entry.name)) continue
			const entryPath = path.join(directory, entry.name)
			const relativePath = path
				.relative(baseDirectory, entryPath)
				.split(path.sep)
				.join(path.posix.sep)

			if (entry.isDirectory()) {
				files.push(`${relativePath}/`)
				files.push(
					...(yield* listDirectoryFilesRecursiveFrom(
						entryPath,
						baseDirectory,
						excludeRootEntries,
						toolName,
					)),
				)
				continue
			}

			if (entry.isFile()) {
				files.push(relativePath)
				continue
			}

			return yield* toolInputError(
				toolName,
				`Directory contains unsupported file type: ${relativePath}`,
			)
		}

		return files
	})
}

export const listDirectoryFilesRecursive = Effect.fn(function* listDirectoryFilesRecursive(
	directory: string,
	toolName: string,
	excludeRootEntries: ReadonlyArray<string> = [],
) {
	return yield* listDirectoryFilesRecursiveFrom(directory, directory, excludeRootEntries, toolName)
})
