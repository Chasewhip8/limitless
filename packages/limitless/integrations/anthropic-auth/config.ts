import { Effect, Schema } from 'effect'
import { schemaErrorMessage } from '../../lib/guards'

export const AnthropicSubscriptionAuthOptionsBlock = Schema.Struct({
	enable: Schema.optional(Schema.Boolean),
})
export const AnthropicSubscriptionAuthPluginOptions = Schema.Struct({
	anthropicSubscriptionAuth: Schema.optional(AnthropicSubscriptionAuthOptionsBlock),
})
export const AnthropicSubscriptionAuthConfig = Schema.Struct({ enabled: Schema.Boolean })
export type AnthropicSubscriptionAuthConfig = typeof AnthropicSubscriptionAuthConfig.Type

export class AnthropicSubscriptionAuthConfigError extends Schema.TaggedErrorClass<AnthropicSubscriptionAuthConfigError>()(
	'AnthropicSubscriptionAuthConfigError',
	{ message: Schema.String },
) {}

export const DEFAULT_ANTHROPIC_SUBSCRIPTION_AUTH_CONFIG = AnthropicSubscriptionAuthConfig.make({
	enabled: true,
})

export const normalizeAnthropicSubscriptionAuthConfig = Effect.fn(
	'normalizeAnthropicSubscriptionAuthConfig',
)(function* (options: unknown) {
	if (options === undefined) return DEFAULT_ANTHROPIC_SUBSCRIPTION_AUTH_CONFIG
	const decoded = yield* Schema.decodeUnknownEffect(AnthropicSubscriptionAuthPluginOptions)(
		options,
	).pipe(
		Effect.mapError(
			(error) => new AnthropicSubscriptionAuthConfigError({ message: schemaErrorMessage(error) }),
		),
	)
	return AnthropicSubscriptionAuthConfig.make({
		enabled: decoded.anthropicSubscriptionAuth?.enable ?? true,
	})
})
