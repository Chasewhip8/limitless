import { Effect, Schema } from 'effect'
import { objectProperty, ToolInputError } from '../shared'

export function toolInputError(toolName: string, message: string) {
	return new ToolInputError({ tool: toolName, message })
}

export function artifactOperationError(toolName: string, message: string, error: unknown) {
	const code = objectProperty(error, 'code')
	const suffix = typeof code === 'string' ? ` (${code})` : ''
	return toolInputError(toolName, `${message}${suffix}`)
}

export function isAlreadyExists(error: unknown): boolean {
	return objectProperty(error, 'code') === 'EEXIST'
}

export function isMissingPath(error: unknown): boolean {
	const code = objectProperty(error, 'code')
	return code === 'ENOENT' || code === 'ENOTDIR'
}

export const decodeToolValue = Effect.fn(function* decodeToolValue<Decoded>(
	toolName: string,
	schema: Schema.Decoder<Decoded>,
	value: unknown,
	message: string,
) {
	return yield* Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError(() => toolInputError(toolName, message)),
	)
})
