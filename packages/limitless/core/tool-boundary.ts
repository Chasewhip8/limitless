import type { ToolContext, ToolResult } from '@opencode-ai/plugin'
import { Effect, Match, Schema } from 'effect'
import { schemaErrorMessage } from '../lib/guards'
import { optionalField } from '../lib/type-utils'
import {
	FileAccessError,
	FileAccessFailurePayload,
	type ToolFailure,
	ToolFailurePayload,
	ToolInputError,
	ToolInputFailurePayload,
	ToolOperationError,
	ToolOperationFailurePayload,
	toolOperationError,
} from './errors'

export { FileAccessError, ToolInputError, ToolOperationError }
export type { ToolFailure }

export function isMetadata(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const toToolResult = Effect.fn(function* toToolResult(tool: string, value: unknown) {
	const encoded = yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(value).pipe(
		Effect.mapError((error) => toolOperationError(tool, 'Could not serialize tool result', error)),
	)
	const json = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(encoded).pipe(
		Effect.mapError((error) => toolOperationError(tool, 'Could not serialize tool result', error)),
	)
	const output = yield* Effect.try({
		try: () => {
			const pretty = JSON.stringify(json, null, 2)
			if (typeof pretty !== 'string') throw new Error('Tool result is not JSON serializable')
			return pretty
		},
		catch: (error) => toolOperationError(tool, 'Could not serialize tool result', error),
	})
	return {
		output,
		metadata: isMetadata(json) ? json : { result: json },
	} satisfies ToolResult
})

export function failurePayload(error: ToolFailure): ToolFailurePayload {
	return Match.valueTags(error, {
		ToolInputError: (error) =>
			ToolInputFailurePayload.make({
				ok: false,
				error: error._tag,
				tool: error.tool,
				message: error.message,
			}),
		FileAccessError: (error) =>
			FileAccessFailurePayload.make({
				ok: false,
				error: error._tag,
				filePath: error.filePath,
				message: error.message,
			}),
		ToolOperationError: (error) =>
			ToolOperationFailurePayload.make({
				ok: false,
				error: error._tag,
				tool: error.tool,
				message: error.message,
				...optionalField('code', error.code),
			}),
	})
}

function isToolFailure(error: unknown): error is ToolFailure {
	return (
		error instanceof ToolInputError ||
		error instanceof FileAccessError ||
		error instanceof ToolOperationError
	)
}

function encodeFailure<BodyError>(
	error: ToolFailure | BodyError,
	bodyFailure:
		| {
				readonly is: (error: unknown) => error is BodyError
				readonly encode: (error: BodyError) => Effect.Effect<unknown>
		  }
		| undefined,
): Effect.Effect<unknown> {
	if (isToolFailure(error)) {
		return Schema.encodeUnknownEffect(ToolFailurePayload)(failurePayload(error)).pipe(Effect.orDie)
	}
	if (bodyFailure?.is(error)) {
		return bodyFailure.encode(error)
	}
	return Effect.die(error)
}

export function executeTool<
	InputSchema extends Schema.Decoder<unknown>,
	ResultSchema extends Schema.Codec<unknown, unknown>,
>(
	name: string,
	inputSchema: InputSchema,
	resultSchema: ResultSchema,
	input: unknown,
	context: ToolContext,
	body: (
		args: InputSchema['Type'],
		context: ToolContext,
	) => Effect.Effect<ResultSchema['Type'], ToolFailure>,
): Promise<ToolResult>
export function executeTool<
	InputSchema extends Schema.Decoder<unknown>,
	ResultSchema extends Schema.Codec<unknown, unknown>,
	BodyError,
>(
	name: string,
	inputSchema: InputSchema,
	resultSchema: ResultSchema,
	input: unknown,
	context: ToolContext,
	body: (
		args: InputSchema['Type'],
		context: ToolContext,
	) => Effect.Effect<ResultSchema['Type'], ToolFailure | BodyError>,
	bodyFailure: {
		readonly is: (error: unknown) => error is BodyError
		readonly encode: (error: BodyError) => Effect.Effect<unknown>
	},
): Promise<ToolResult>
export function executeTool<
	InputSchema extends Schema.Decoder<unknown>,
	ResultSchema extends Schema.Codec<unknown, unknown>,
	BodyError,
>(
	name: string,
	inputSchema: InputSchema,
	resultSchema: ResultSchema,
	input: unknown,
	context: ToolContext,
	body: (
		args: InputSchema['Type'],
		context: ToolContext,
	) => Effect.Effect<ResultSchema['Type'], ToolFailure | BodyError>,
	bodyFailure?: {
		readonly is: (error: unknown) => error is BodyError
		readonly encode: (error: BodyError) => Effect.Effect<unknown>
	},
): Promise<ToolResult> {
	const program = Schema.decodeUnknownEffect(inputSchema)(input).pipe(
		Effect.mapError(
			(error) =>
				new ToolInputError({
					tool: name,
					message: schemaErrorMessage(error),
				}),
		),
		Effect.flatMap((args) => body(args, context)),
		Effect.flatMap((value) =>
			Schema.encodeUnknownEffect(resultSchema)(value).pipe(
				Effect.mapError((error) =>
					toolOperationError(name, 'Tool implementation returned invalid output', error),
				),
			),
		),
		Effect.flatMap((value) => toToolResult(name, value)),
		Effect.catch((error) =>
			encodeFailure(error, bodyFailure).pipe(
				Effect.flatMap((payload) => toToolResult(name, payload)),
			),
		),
		Effect.catchDefect((defect) =>
			Effect.logError(`[limitless] ${name} defect`, defect).pipe(
				Effect.andThen(
					toToolResult(
						name,
						ToolOperationFailurePayload.make({
							ok: false,
							error: 'ToolOperationError',
							tool: name,
							message: 'Tool execution failed unexpectedly.',
						}),
					),
				),
			),
		),
	)
	return Effect.runPromise(program)
}
