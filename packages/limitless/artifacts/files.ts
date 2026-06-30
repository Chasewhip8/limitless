import { lstat, mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Effect, Schema } from 'effect'
import { artifactOperationError, isAlreadyExists, isMissingPath, toolInputError } from './errors'
import {
	artifactDirectoryPath,
	artifactManifestPath,
	artifactsRoot,
	LIMITLESS_DIRECTORY,
} from './paths'
import { ArtifactManifest } from './schemas'

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
		catch: (error) => artifactOperationError(toolName, message, error),
	})
})

export const ensureArtifactsRoot = Effect.fn(function* ensureArtifactsRoot(
	worktree: string,
	create: boolean,
	toolName: string,
) {
	const limitlessRoot = path.resolve(worktree, LIMITLESS_DIRECTORY)
	const limitlessExists = yield* ensureDirectory(
		limitlessRoot,
		create,
		toolName,
		'Could not inspect artifact directory',
	)
	if (!limitlessExists) return undefined

	const root = artifactsRoot(worktree)
	const artifactsExists = yield* ensureDirectory(
		root,
		create,
		toolName,
		'Could not inspect artifact directory',
	)
	return artifactsExists ? root : undefined
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
		catch: (error) => artifactOperationError(toolName, 'Could not write artifact file', error),
	})
})

export const writeJsonFile = Effect.fn(function* writeJsonFile(
	filePath: string,
	value: unknown,
	toolName: string,
) {
	return yield* writeNewFile(filePath, `${JSON.stringify(value, null, 2)}\n`, toolName)
})

export const ensureArtifactDirectory = Effect.fn(function* ensureArtifactDirectory(
	worktree: string,
	slug: Parameters<typeof artifactDirectoryPath>[1],
	toolName: string,
) {
	return yield* Effect.tryPromise({
		try: async () => {
			const directory = artifactDirectoryPath(worktree, slug)
			const info = await lstat(directory)
			if (!info.isDirectory()) throw new Error('Artifact path is not a regular directory')
			return directory
		},
		catch: (error) =>
			artifactOperationError(toolName, 'Could not inspect artifact workspace', error),
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
		catch: (error) => artifactOperationError(toolName, 'Could not inspect artifact file', error),
	})
})

const readTextFile = Effect.fn(function* readTextFile(
	filePath: string,
	toolName: string,
	message: string,
) {
	return yield* Effect.tryPromise({
		try: () => readFile(filePath, 'utf8'),
		catch: (error) => artifactOperationError(toolName, message, error),
	})
})

export const readArtifactManifest = Effect.fn(function* readArtifactManifest(
	worktree: string,
	slug: Parameters<typeof artifactManifestPath>[1],
	toolName: string,
) {
	const content = yield* readTextFile(
		artifactManifestPath(worktree, slug),
		toolName,
		'Could not read artifact manifest',
	)
	const parsed = yield* Effect.try({
		try: () => JSON.parse(content) as unknown,
		catch: () => toolInputError(toolName, 'Invalid artifact manifest JSON'),
	})
	const manifest = yield* Schema.decodeUnknownEffect(ArtifactManifest)(parsed).pipe(
		Effect.mapError(() => toolInputError(toolName, 'Invalid artifact manifest')),
	)
	if (manifest.slug !== slug) {
		return yield* Effect.fail(toolInputError(toolName, 'Artifact manifest slug mismatch'))
	}
	return manifest
})
