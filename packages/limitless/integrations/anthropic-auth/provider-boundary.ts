import { AnthropicAuthPlugin } from '@ex-machina/opencode-anthropic-auth'
import type { AuthHook, PluginInput } from '@opencode-ai/plugin'
import { Effect } from 'effect'

export type AnthropicV1AuthLoader = NonNullable<AuthHook['loader']>

type AnthropicV1ClientFacade = {
	readonly auth: {
		readonly set: (input: unknown) => Promise<never>
	}
}

const clientFacade: AnthropicV1ClientFacade = {
	auth: {
		set: () =>
			Promise.reject(
				new Error(
					'Anthropic credential refresh must be persisted by the OpenCode 2 integration lifecycle.',
				),
			),
	},
}

/**
 * Loads the package through its public V1 plugin entrypoint. The dependency only reads
 * `client.auth.set`; the V2 adapter deliberately rejects that write because V2 owns refresh and
 * persistence. The cast is the complete V1 facade boundary, not a fabricated V2 client.
 */
export async function loadAnthropicV1AuthLoader(): Promise<AnthropicV1AuthLoader> {
	const hooks = await AnthropicAuthPlugin({ client: clientFacade } as unknown as PluginInput)
	const loader = hooks.auth?.provider === 'anthropic' ? hooks.auth.loader : undefined
	if (loader === undefined) {
		throw new Error('@ex-machina/opencode-anthropic-auth did not expose its Anthropic auth loader.')
	}
	return loader
}

/** The upstream loader only reads `models` from this otherwise broad V1 provider shape. */
export function anthropicV1ProviderFacade(): Parameters<AnthropicV1AuthLoader>[1] {
	return { models: {} } as unknown as Parameters<AnthropicV1AuthLoader>[1]
}

/** Runs the dependency's Promise callback at the sole Effect-to-V1 boundary. */
export function runAnthropicV1Auth<A>(effect: Effect.Effect<A>): Promise<A> {
	return Effect.runPromise(effect)
}
