import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { Effect, Exit, Schema } from 'effect'
import {
	isAlreadyExists,
	isMissingPath,
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
	// Preserve the write failure while allowing a cleanup failure to reach the caller.
	const written = yield* Effect.acquireUseRelease(
		operationPromise(toolName, message, () => open(filePath, 'wx')),
		(handle) =>
			operationPromise(toolName, message, () => handle.writeFile(content, 'utf8')).pipe(
				Effect.exit,
			),
		(handle, exit) =>
			Effect.gen(function* () {
				const closed = yield* Effect.exit(
					operationPromise(toolName, 'Could not close artifact file', () => handle.close()),
				)
				if (Exit.isFailure(exit) || Exit.isFailure(exit.value) || Exit.isFailure(closed)) {
					yield* operationPromise(toolName, 'Could not remove incomplete artifact file', () =>
						unlink(filePath),
					)
				}
				if (Exit.isFailure(closed)) return yield* Effect.failCause(closed.cause)
			}),
	)
	if (Exit.isFailure(written)) return yield* Effect.failCause(written.cause)
	return written.value
})

export const writeJsonFile = Effect.fn(function* writeJsonFile(
	filePath: string,
	value: unknown,
	toolName: string,
) {
	const encoded = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
		value,
	).pipe(
		Effect.mapError((error) =>
			toolOperationError(toolName, 'Could not serialize artifact JSON', error),
		),
	)
	const json = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
		encoded,
	).pipe(
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
	const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
		content,
	).pipe(Effect.mapError(() => toolInputError(toolName, `Invalid ${label} JSON`)))
	return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
		Effect.mapError(() => toolInputError(toolName, `Invalid ${label}`)),
	)
})
