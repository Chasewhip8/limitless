import { Effect } from 'effect'
import { executeAnthropicOAuthRequest } from './transform'

/** Converts the Effect request adapter to the Promise fetch contract required by AI SDK. */
export function makeAnthropicOAuthFetch(accessToken: string, upstreamFetch: typeof fetch) {
	return async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
		Effect.runPromise(executeAnthropicOAuthRequest(accessToken, upstreamFetch, input, init))
}
