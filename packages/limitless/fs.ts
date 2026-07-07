import { constants as fsConstants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Effect, Schema } from 'effect'
import { isAlreadyExists, isMissingPath, toolInputError, toolOperationError } from './lib/errors'

export const ensureDirectory = Effect.fn(function* ensureDirectory(
	directory: string,
	create: boolean,
	toolName: string,
	message: string,
) {
	return yield* Effect.tryPromise({
		try: async () => {
			try {
				const info = await lstat(directory)
				if (!info.isDirectory()) throw new Error('Path is not a regular directory')
				return true
			} catch (error) {
				if (!isMissingPath(error)) throw error
				if (!create) return false
			}

			try {
				await mkdir(directory)
			} catch (error) {
				if (!isAlreadyExists(error)) throw error
			}

			const info = await lstat(directory)
			if (!info.isDirectory()) throw new Error('Path is not a regular directory')
			return true
		},
		catch: (error) => toolOperationError(toolName, message, error),
	})
})

export const writeNewFile = Effect.fn(function* writeNewFile(
	filePath: string,
	content: string,
	toolName: string,
) {
	return yield* Effect.tryPromise({
		try: async () => {
			const handle = await open(filePath, 'wx')
			try {
				await handle.writeFile(content, 'utf8')
			} finally {
				await handle.close()
			}
		},
		catch: (error) => toolOperationError(toolName, 'Could not write artifact file', error),
	})
})

export const writeJsonFile = Effect.fn(function* writeJsonFile(
	filePath: string,
	value: unknown,
	toolName: string,
) {
	return yield* writeNewFile(filePath, `${JSON.stringify(value, null, 2)}\n`, toolName)
})

async function createExclusiveDirectory(directory: string): Promise<void> {
	await mkdir(directory)
	const info = await lstat(directory)
	if (!info.isDirectory()) throw new Error('Path is not a regular directory')
}

async function copyDirectoryContentsUnsafe(
	source: string,
	destination: string,
	excludeRootEntries: ReadonlyArray<string>,
	baseDirectory = source,
): Promise<void> {
	const entries = await readdir(source, { withFileTypes: true })

	for (const entry of entries.slice().sort((left, right) => left.name.localeCompare(right.name))) {
		if (source === baseDirectory && excludeRootEntries.includes(entry.name)) continue

		const sourcePath = path.join(source, entry.name)
		const destinationPath = path.join(destination, entry.name)
		const relativePath = path
			.relative(baseDirectory, sourcePath)
			.split(path.sep)
			.join(path.posix.sep)
		if (entry.isDirectory()) {
			await createExclusiveDirectory(destinationPath)
			await copyDirectoryContentsUnsafe(
				sourcePath,
				destinationPath,
				excludeRootEntries,
				baseDirectory,
			)
			continue
		}

		if (entry.isFile()) {
			await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL)
			continue
		}

		throw new Error(`Template contains unsupported file type: ${relativePath}`)
	}
}

export const copyDirectoryContents = Effect.fn(function* copyDirectoryContents(
	source: string,
	destination: string,
	toolName: string,
	excludeRootEntries: ReadonlyArray<string> = [],
) {
	return yield* Effect.tryPromise({
		try: () => copyDirectoryContentsUnsafe(source, destination, excludeRootEntries),
		catch: (error) => toolOperationError(toolName, 'Could not copy template files', error),
	})
})

export const ensureRegularFile = Effect.fn(function* ensureRegularFile(
	filePath: string,
	missingMessage: string,
	toolName: string,
) {
	return yield* Effect.tryPromise({
		try: async () => {
			try {
				const info = await lstat(filePath)
				if (!info.isFile()) throw new Error('Path is not a regular file')
			} catch (error) {
				if (isMissingPath(error)) throw new Error(missingMessage)
				throw error
			}
		},
		catch: (error) => toolOperationError(toolName, 'Could not inspect artifact file', error),
	})
})

const readTextFile = Effect.fn(function* readTextFile(
	filePath: string,
	toolName: string,
	message: string,
) {
	return yield* Effect.tryPromise({
		try: () => readFile(filePath, 'utf8'),
		catch: (error) => toolOperationError(toolName, message, error),
	})
})

export const readJsonFile = Effect.fn(function* readJsonFile<Decoded>(
	filePath: string,
	schema: Schema.Decoder<Decoded>,
	toolName: string,
	label: string,
) {
	const content = yield* readTextFile(filePath, toolName, `Could not read ${label}`)
	const parsed = yield* Effect.try({
		try: () => JSON.parse(content) as unknown,
		catch: () => toolInputError(toolName, `Invalid ${label} JSON`),
	})
	return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
		Effect.mapError(() => toolInputError(toolName, `Invalid ${label}`)),
	)
})

async function listDirectoryFilesRecursiveUnsafe(
	directory: string,
	baseDirectory: string,
	excludeRootEntries: ReadonlyArray<string>,
): Promise<Array<string>> {
	const entries = await readdir(directory, { withFileTypes: true })
	const files: Array<string> = []

	for (const entry of entries.slice().sort((left, right) => left.name.localeCompare(right.name))) {
		if (directory === baseDirectory && excludeRootEntries.includes(entry.name)) continue
		const entryPath = path.join(directory, entry.name)
		const relativePath = path
			.relative(baseDirectory, entryPath)
			.split(path.sep)
			.join(path.posix.sep)

		if (entry.isDirectory()) {
			files.push(`${relativePath}/`)
			files.push(
				...(await listDirectoryFilesRecursiveUnsafe(entryPath, baseDirectory, excludeRootEntries)),
			)
			continue
		}

		if (entry.isFile()) {
			files.push(relativePath)
			continue
		}

		throw new Error(`Directory contains unsupported file type: ${relativePath}`)
	}

	return files
}

export const listDirectoryFilesRecursive = Effect.fn(function* listDirectoryFilesRecursive(
	directory: string,
	toolName: string,
	excludeRootEntries: ReadonlyArray<string> = [],
) {
	return yield* Effect.tryPromise({
		try: () => listDirectoryFilesRecursiveUnsafe(directory, directory, excludeRootEntries),
		catch: (error) => toolOperationError(toolName, 'Could not list directory files', error),
	})
})
