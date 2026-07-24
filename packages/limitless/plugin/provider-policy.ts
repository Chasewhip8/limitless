import type { CatalogDraft } from '@opencode-ai/plugin/v2/effect/catalog'
import { Effect, Schema } from 'effect'
import { TrimmedNonEmptyString } from '../core/command'
import { schemaErrorMessage } from '../lib/guards'

export const DEFAULT_DISABLED_PROVIDERS = ['google-vertex', 'google-vertex-anthropic'] as const

const ProviderPolicyOptions = Schema.Struct({
	providers: Schema.optional(
		Schema.Struct({
			disabled: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
		}),
	),
})

export const ProviderPolicyConfig = Schema.Struct({
	disabled: Schema.Array(TrimmedNonEmptyString),
})
export type ProviderPolicyConfig = typeof ProviderPolicyConfig.Type

export class ProviderPolicyConfigError extends Schema.TaggedErrorClass<ProviderPolicyConfigError>()(
	'ProviderPolicyConfigError',
	{ message: Schema.String },
) {}

export const normalizeProviderPolicyConfig = Effect.fn('normalizeProviderPolicyConfig')(function* (
	options: unknown,
) {
	const decoded = yield* Schema.decodeUnknownEffect(ProviderPolicyOptions)(options ?? {}).pipe(
		Effect.mapError(
			(error) => new ProviderPolicyConfigError({ message: schemaErrorMessage(error) }),
		),
	)
	return ProviderPolicyConfig.make({
		disabled: [...new Set(decoded.providers?.disabled ?? DEFAULT_DISABLED_PROVIDERS)],
	})
})

export function applyProviderPolicy(catalog: CatalogDraft, config: ProviderPolicyConfig): void {
	for (const providerID of config.disabled) {
		if (!catalog.provider.get(providerID)) continue
		catalog.provider.update(providerID, (provider) => {
			provider.disabled = true
		})
	}
}
