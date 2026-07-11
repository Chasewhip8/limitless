import { Schema } from 'effect'

export class ToolInputError extends Schema.TaggedErrorClass<ToolInputError>()('ToolInputError', {
	tool: Schema.String,
	message: Schema.String,
}) {}

export class FileAccessError extends Schema.TaggedErrorClass<FileAccessError>()('FileAccessError', {
	filePath: Schema.String,
	message: Schema.String,
}) {}

export class ToolOperationError extends Schema.TaggedErrorClass<ToolOperationError>()(
	'ToolOperationError',
	{
		tool: Schema.String,
		message: Schema.String,
		code: Schema.optional(Schema.String),
	},
) {}

export const ToolFailure = Schema.Union([ToolInputError, FileAccessError, ToolOperationError])
export type ToolFailure = typeof ToolFailure.Type

export const ToolInputFailurePayload = Schema.Struct({
	ok: Schema.Literal(false),
	error: Schema.Literal('ToolInputError'),
	tool: Schema.String,
	message: Schema.String,
})

export const FileAccessFailurePayload = Schema.Struct({
	ok: Schema.Literal(false),
	error: Schema.Literal('FileAccessError'),
	filePath: Schema.String,
	message: Schema.String,
})

export const ToolOperationFailurePayload = Schema.Struct({
	ok: Schema.Literal(false),
	error: Schema.Literal('ToolOperationError'),
	tool: Schema.String,
	message: Schema.String,
	code: Schema.optional(Schema.String),
})

export const ToolFailurePayload = Schema.Union([
	ToolInputFailurePayload,
	FileAccessFailurePayload,
	ToolOperationFailurePayload,
])
export type ToolFailurePayload = typeof ToolFailurePayload.Type

function errorCode(error: unknown): unknown {
	return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
}

export function toolInputError(tool: string, message: string) {
	return new ToolInputError({ tool, message })
}

// Wraps a thrown fs/OS error, keeping only the errno code so absolute host paths
// from the underlying error never leak into tool output.
export function toolOperationError(tool: string, message: string, error: unknown) {
	const code = errorCode(error)
	return new ToolOperationError({
		tool,
		message: typeof code === 'string' ? `${message} (${code})` : message,
		...(typeof code === 'string' ? { code } : {}),
	})
}

export function isAlreadyExists(error: unknown): boolean {
	return errorCode(error) === 'EEXIST'
}

export function isMissingPath(error: unknown): boolean {
	const code = errorCode(error)
	return code === 'ENOENT' || code === 'ENOTDIR'
}
