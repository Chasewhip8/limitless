import { Schema } from 'effect'

export class ToolInputError extends Schema.TaggedErrorClass<ToolInputError>()('ToolInputError', {
	tool: Schema.String,
	message: Schema.String,
}) {}

export class FileAccessError extends Schema.TaggedErrorClass<FileAccessError>()('FileAccessError', {
	filePath: Schema.String,
	message: Schema.String,
}) {}

export class LspToolError extends Schema.TaggedErrorClass<LspToolError>()('LspToolError', {
	tool: Schema.String,
	message: Schema.String,
	server: Schema.optional(Schema.String),
}) {}

export type ToolFailure = ToolInputError | FileAccessError | LspToolError

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
	return toolInputError(tool, typeof code === 'string' ? `${message} (${code})` : message)
}

export function isAlreadyExists(error: unknown): boolean {
	return errorCode(error) === 'EEXIST'
}

export function isMissingPath(error: unknown): boolean {
	const code = errorCode(error)
	return code === 'ENOENT' || code === 'ENOTDIR'
}
