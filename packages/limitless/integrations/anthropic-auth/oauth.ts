/**
 * Derived from @ex-machina/opencode-anthropic-auth 1.8.1 (MIT).
 * Copyright (c) 2026 Ex Machina. See LICENSE.ex-machina.
 */
import type { IntegrationOAuthMethodRegistration } from '@opencode-ai/plugin/v2/effect/integration'
import { Deferred, Effect, Exit, Schedule, Schema, SynchronizedRef } from 'effect'

export const ANTHROPIC_INTEGRATION_ID = 'anthropic'
export const ANTHROPIC_OAUTH_METHOD_ID = 'limitless-claude-pro-max'
export const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const ANTHROPIC_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
export const ANTHROPIC_CALLBACK_URL = 'https://platform.claude.com/oauth/code/callback'
export const ANTHROPIC_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

const oauthScopes = [
	'org:create_api_key',
	'user:profile',
	'user:inference',
	'user:sessions:claude_code',
	'user:mcp_servers',
	'user:file_upload',
]
const tokenHeaders = {
	'Content-Type': 'application/json',
	Accept: 'application/json, text/plain, */*',
	'User-Agent': 'axios/1.13.6',
}
const TokenResponse = Schema.Struct({
	refresh_token: Schema.NonEmptyString,
	access_token: Schema.NonEmptyString,
	expires_in: Schema.Int.check(Schema.isGreaterThan(0)),
})
type TokenResponse = typeof TokenResponse.Type
type CredentialOAuth = Parameters<NonNullable<IntegrationOAuthMethodRegistration['refresh']>>[0]
type RefreshDeferred = Deferred.Deferred<CredentialOAuth, AnthropicOAuthError>
type RefreshFlight = Readonly<{
	owner: boolean
	deferred: RefreshDeferred
}>

export class AnthropicOAuthError extends Schema.TaggedErrorClass<AnthropicOAuthError>()(
	'AnthropicOAuthError',
	{
		message: Schema.String,
		retryable: Schema.Boolean,
	},
) {}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=/gu, '')
}

export const generateAnthropicPkce = Effect.fn('generateAnthropicPkce')(function* () {
	const bytes = new Uint8Array(64)
	crypto.getRandomValues(bytes)
	const verifier = base64UrlEncode(bytes)
	const digest = yield* Effect.promise(() =>
		crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
	)
	return {
		verifier,
		challenge: base64UrlEncode(new Uint8Array(digest)),
		method: 'S256' as const,
	}
})

function callbackParameters(input: string) {
	const trimmed = input.trim()
	const url = (() => {
		try {
			return new URL(trimmed)
		} catch {
			return undefined
		}
	})()
	const urlCode = url?.searchParams.get('code')
	const urlState = url?.searchParams.get('state')
	if (urlCode && urlState) return { code: urlCode, state: urlState }

	const hashParts = trimmed.split('#')
	if (hashParts.length === 2 && hashParts[0] && hashParts[1]) {
		return { code: hashParts[0], state: hashParts[1] }
	}

	const parameters = new URLSearchParams(trimmed)
	const code = parameters.get('code')
	const state = parameters.get('state')
	return code && state ? { code, state } : undefined
}

const requestTokenOnce = Effect.fn('requestAnthropicTokenOnce')(function* (
	fetcher: typeof fetch,
	body: Readonly<Record<string, string>>,
) {
	const response = yield* Effect.tryPromise({
		try: (signal) =>
			fetcher(ANTHROPIC_TOKEN_URL, {
				method: 'POST',
				headers: tokenHeaders,
				body: JSON.stringify(body),
				signal,
			}),
		catch: (cause) =>
			new AnthropicOAuthError({
				message: cause instanceof Error ? cause.message : 'Anthropic OAuth request failed.',
				retryable: true,
			}),
	})
	if (!response.ok) {
		const responseBody = yield* Effect.tryPromise({
			try: () => response.text(),
			catch: (cause) =>
				new AnthropicOAuthError({
					message: cause instanceof Error ? cause.message : 'Unable to read Anthropic OAuth error.',
					retryable: false,
				}),
		}).pipe(Effect.orElseSucceed(() => ''))
		return yield* new AnthropicOAuthError({
			message: `Anthropic OAuth request failed: ${response.status}${responseBody ? ` — ${responseBody}` : ''}`,
			retryable: response.status >= 500,
		})
	}
	const payload = yield* Effect.tryPromise({
		try: () => response.json(),
		catch: (cause) =>
			new AnthropicOAuthError({
				message: cause instanceof Error ? cause.message : 'Anthropic returned invalid OAuth JSON.',
				retryable: false,
			}),
	})
	return yield* Schema.decodeUnknownEffect(TokenResponse)(payload).pipe(
		Effect.mapError(
			() =>
				new AnthropicOAuthError({
					message: 'Anthropic returned an invalid OAuth token response.',
					retryable: false,
				}),
		),
	)
})

const requestToken = (fetcher: typeof fetch, body: Readonly<Record<string, string>>) =>
	requestTokenOnce(fetcher, body).pipe(
		Effect.retry({
			schedule: Schedule.exponential('500 millis'),
			times: 2,
			while: (error) => error.retryable,
		}),
	)

function credential(
	tokens: TokenResponse,
	currentTimeMillis: () => number,
	metadata?: Record<string, unknown>,
) {
	return {
		type: 'oauth' as const,
		methodID: ANTHROPIC_OAUTH_METHOD_ID,
		refresh: tokens.refresh_token,
		access: tokens.access_token,
		expires: currentTimeMillis() + tokens.expires_in * 1_000,
		...(metadata === undefined ? {} : { metadata }),
	}
}

export function anthropicOAuthMethod(
	fetcher: typeof fetch = fetch,
	currentTimeMillis: () => number = Date.now,
): IntegrationOAuthMethodRegistration {
	const refreshes = SynchronizedRef.makeUnsafe(new Map<string, RefreshDeferred>())
	const refresh = Effect.fn('refreshAnthropicOAuthCredential')(function* (
		current: CredentialOAuth,
	) {
		const flight = yield* SynchronizedRef.modify<Map<string, RefreshDeferred>, RefreshFlight>(
			refreshes,
			(active) => {
				const existing = active.get(current.refresh)
				if (existing !== undefined) {
					return [{ owner: false, deferred: existing }, active]
				}
				const deferred = Deferred.makeUnsafe<CredentialOAuth, AnthropicOAuthError>()
				return [{ owner: true, deferred }, new Map(active).set(current.refresh, deferred)]
			},
		)
		if (!flight.owner) return yield* Deferred.await(flight.deferred)

		return yield* Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const result = yield* requestToken(fetcher, {
					grant_type: 'refresh_token',
					refresh_token: current.refresh,
					client_id: ANTHROPIC_CLIENT_ID,
				}).pipe(
					Effect.map((tokens) => credential(tokens, currentTimeMillis, current.metadata)),
					restore,
					Effect.exit,
				)
				yield* Deferred.done(flight.deferred, result)
				yield* SynchronizedRef.update(refreshes, (active) => {
					if (active.get(current.refresh) !== flight.deferred) return active
					const next = new Map(active)
					next.delete(current.refresh)
					return next
				})
				if (Exit.isSuccess(result)) return result.value
				return yield* Effect.failCause(result.cause)
			}),
		)
	})

	return {
		integrationID: ANTHROPIC_INTEGRATION_ID,
		method: {
			id: ANTHROPIC_OAUTH_METHOD_ID,
			type: 'oauth',
			label: 'Claude Pro/Max subscription',
		},
		authorize: () =>
			Effect.gen(function* () {
				const pkce = yield* generateAnthropicPkce()
				const state = crypto.randomUUID().replace(/-/gu, '')
				const url = new URL(ANTHROPIC_AUTHORIZE_URL)
				url.searchParams.set('code', 'true')
				url.searchParams.set('client_id', ANTHROPIC_CLIENT_ID)
				url.searchParams.set('response_type', 'code')
				url.searchParams.set('redirect_uri', ANTHROPIC_CALLBACK_URL)
				url.searchParams.set('scope', oauthScopes.join(' '))
				url.searchParams.set('code_challenge', pkce.challenge)
				url.searchParams.set('code_challenge_method', pkce.method)
				url.searchParams.set('state', state)
				return {
					mode: 'code' as const,
					url: url.toString(),
					instructions: 'Paste the authorization code here:',
					callback: (input: string) => {
						const callback = callbackParameters(input)
						if (!callback || callback.state !== state) {
							return Effect.fail(
								new AnthropicOAuthError({
									message: 'The Anthropic authorization code or OAuth state is invalid.',
									retryable: false,
								}),
							)
						}
						return requestToken(fetcher, {
							code: callback.code,
							state: callback.state,
							grant_type: 'authorization_code',
							client_id: ANTHROPIC_CLIENT_ID,
							redirect_uri: ANTHROPIC_CALLBACK_URL,
							code_verifier: pkce.verifier,
						}).pipe(Effect.map((tokens) => credential(tokens, currentTimeMillis)))
					},
				}
			}),
		refresh,
	}
}
