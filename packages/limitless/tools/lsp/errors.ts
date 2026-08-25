import { Tool } from '@opencode-ai/schema/tool'
import { Effect, Schema } from 'effect'
import { schemaErrorMessage } from '../../lib/guards'

export class LspToolError extends Schema.TaggedError<LspToolError>()('LspToolError', {
	tool: Schema.String,
	message: Schema.String,
	server: Schema.optional(Schema.String),
}) {}

export const LspToolFailurePayload = Schema.Struct({
	ok: Schema.Literal(false),
	error: Schema.Literal('LspToolError'),
	tool: Schema.String,
	message: Schema.String,
	server: Schema.optional(Schema.String),
})

function lspToolFailurePayload(error: LspToolError): typeof LspToolFailurePayload.Type {
	return LspToolFailurePayload.make({
		ok: false,
		error: error._tag,
		tool: error.tool,
		message: error.message,
		...(error.server === undefined ? {} : { server: error.server }),
	})
}

export const encodeLspToolFailure = (error: LspToolError) =>
	new Tool.Error({ message: error.message, metadata: lspToolFailurePayload(error) })

export function lspError(tool: string, message: string, server?: string) {
	return new LspToolError(server === undefined ? { tool, message } : { tool, message, server })
}

export function decodeServerValue<T>(
	tool: string,
	server: string,
	description: string,
	schema: Schema.Decoder<T>,
	value: unknown,
): Effect.Effect<T, LspToolError> {
	return Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError((error) =>
			lspError(tool, `${description}: ${schemaErrorMessage(error)}`, server),
		),
	)
}
