import { Effect, Schema } from 'effect'
import { schemaErrorMessage } from '../../lib/guards'

export class LspToolError extends Schema.TaggedErrorClass<LspToolError>()('LspToolError', {
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

export const lspToolFailureEncoder = {
	is: (error: unknown): error is LspToolError => error instanceof LspToolError,
	encode: (error: LspToolError): Effect.Effect<unknown> =>
		Schema.encodeUnknownEffect(LspToolFailurePayload)(lspToolFailurePayload(error)).pipe(
			Effect.orDie,
		),
}

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
