import { Schema } from 'effect'

export class OAuthError extends Schema.TaggedErrorClass<OAuthError>()('AnthropicOAuthError', {
	operation: Schema.Literals(['authorize', 'exchange', 'refresh']),
	message: Schema.String,
	status: Schema.optional(Schema.Number),
	transient: Schema.Boolean,
}) {}
