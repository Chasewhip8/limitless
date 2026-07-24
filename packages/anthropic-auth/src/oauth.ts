import { Effect, Result, Schema } from 'effect'
import {
	AUTHORIZE_URL,
	CLIENT_ID,
	CODE_CALLBACK_URL,
	MAX_METADATA_KEY,
	MAX_METHOD_ID,
	OAUTH_SCOPES,
	TOKEN_URL,
} from './constants'
import { OAuthError } from './oauth-error'
import { generatePKCE } from './pkce'

export type OAuthTransport = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>

export type OAuthCredential = {
	readonly type: 'oauth'
	readonly methodID: string
	readonly refresh: string
	readonly access: string
	readonly expires: number
	readonly metadata?: Readonly<Record<string, unknown>>
}

type CallbackParameters = {
	readonly code: string
	readonly state: string
}

export type Authorization = {
	readonly url: string
	readonly redirectUri: string
	readonly state: string
	readonly verifier: string
}

type TokenSet = {
	readonly refresh: string
	readonly access: string
	readonly expires: number
}

type TokenOperation = 'exchange' | 'refresh'

type TokenDependencies = {
	readonly transport?: OAuthTransport
	readonly now?: () => number
}

type RefreshDependencies = TokenDependencies & {
	readonly sleep?: (milliseconds: number) => Promise<void>
}

const TokenResponse = Schema.Struct({
	refresh_token: Schema.NonEmptyString,
	access_token: Schema.NonEmptyString,
	expires_in: Schema.Number,
})
const TokenResponseJson = Schema.fromJsonString(TokenResponse)

const AuthorizationRequest = Schema.Struct({
	code: Schema.String,
	state: Schema.String,
	grant_type: Schema.Literal('authorization_code'),
	client_id: Schema.String,
	redirect_uri: Schema.String,
	code_verifier: Schema.String,
})
const encodeAuthorizationRequest = Schema.encodeSync(Schema.fromJsonString(AuthorizationRequest))

const RefreshRequest = Schema.Struct({
	grant_type: Schema.Literal('refresh_token'),
	refresh_token: Schema.String,
	client_id: Schema.String,
})
const encodeRefreshRequest = Schema.encodeSync(Schema.fromJsonString(RefreshRequest))

const refreshInflight = new Map<string, Promise<TokenSet>>()
let latestRefresh: { readonly oldToken: string; readonly tokenSet: TokenSet } | undefined

export function parseCallbackInput(input: string): CallbackParameters | undefined {
	const trimmed = input.trim()
	if (URL.canParse(trimmed)) {
		const url = new URL(trimmed)
		const code = url.searchParams.get('code')
		const state = url.searchParams.get('state')
		if (code && state) return { code, state }
	}

	const hashParts = trimmed.split('#')
	if (hashParts.length === 2 && hashParts[0] && hashParts[1]) {
		return { code: hashParts[0], state: hashParts[1] }
	}

	const parameters = new URLSearchParams(trimmed)
	const code = parameters.get('code')
	const state = parameters.get('state')
	return code && state ? { code, state } : undefined
}

export const authorize = Effect.fn('AnthropicOAuth.authorize')(function* () {
	const pkce = yield* generatePKCE()
	const state = yield* Effect.try({
		try: () => crypto.randomUUID().replace(/-/g, ''),
		catch: () =>
			new OAuthError({
				operation: 'authorize',
				message: 'Unable to create the OAuth state value.',
				transient: false,
			}),
	})
	const url = new URL(AUTHORIZE_URL)
	url.searchParams.set('code', 'true')
	url.searchParams.set('client_id', CLIENT_ID)
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('redirect_uri', CODE_CALLBACK_URL)
	url.searchParams.set('scope', OAUTH_SCOPES.join(' '))
	url.searchParams.set('code_challenge', pkce.challenge)
	url.searchParams.set('code_challenge_method', pkce.method)
	url.searchParams.set('state', state)

	return {
		url: url.toString(),
		redirectUri: CODE_CALLBACK_URL,
		state,
		verifier: pkce.verifier,
	} satisfies Authorization
})

export function exchange(
	input: string,
	verifier: string,
	redirectUri: string,
	expectedState: string,
	dependencies: TokenDependencies = {},
) {
	return Effect.gen(function* () {
		const callback = parseCallbackInput(input)
		if (!callback) {
			return yield* new OAuthError({
				operation: 'exchange',
				message: 'The OAuth callback must include both code and state.',
				transient: false,
			})
		}
		if (callback.state !== expectedState) {
			return yield* new OAuthError({
				operation: 'exchange',
				message: 'The OAuth callback state did not match this authorization attempt.',
				transient: false,
			})
		}

		return yield* requestToken(
			'exchange',
			encodeAuthorizationRequest({
				code: callback.code,
				state: callback.state,
				grant_type: 'authorization_code',
				client_id: CLIENT_ID,
				redirect_uri: redirectUri,
				code_verifier: verifier,
			}),
			dependencies,
		)
	})
}

export function maxCredential(tokenSet: TokenSet): OAuthCredential {
	return {
		type: 'oauth',
		methodID: MAX_METHOD_ID,
		refresh: tokenSet.refresh,
		access: tokenSet.access,
		expires: tokenSet.expires,
		metadata: {
			[MAX_METADATA_KEY]: {
				mode: 'max',
				profile: 'claude-code-2.1.87',
			},
		},
	}
}

export function isMarkedMaxCredential(input: unknown): input is OAuthCredential {
	if (!isRecord(input) || input.type !== 'oauth' || !isRecord(input.metadata)) return false
	const marker = input.metadata[MAX_METADATA_KEY]
	return isRecord(marker) && marker.mode === 'max'
}

export function isMarkedMaxSettings(input: Readonly<Record<string, unknown>>): boolean {
	const marker = input[MAX_METADATA_KEY]
	return isRecord(marker) && marker.mode === 'max'
}

export function refreshCredential(
	credential: OAuthCredential,
	dependencies: RefreshDependencies = {},
) {
	return Effect.tryPromise({
		try: async () => {
			const tokenSet = await refreshTokenSingleflight(credential.refresh, dependencies)
			return {
				type: 'oauth' as const,
				methodID: credential.methodID,
				refresh: tokenSet.refresh,
				access: tokenSet.access,
				expires: tokenSet.expires,
				...(credential.metadata === undefined ? {} : { metadata: credential.metadata }),
			} satisfies OAuthCredential
		},
		catch: (error) =>
			error instanceof OAuthError
				? error
				: new OAuthError({
						operation: 'refresh',
						message: 'The OAuth token refresh failed.',
						transient: false,
					}),
	})
}

async function refreshTokenSingleflight(
	refreshToken: string,
	dependencies: RefreshDependencies,
): Promise<TokenSet> {
	if (latestRefresh?.oldToken === refreshToken) return latestRefresh.tokenSet
	const existing = refreshInflight.get(refreshToken)
	if (existing) return existing

	const pending = requestTokenWithRetry(refreshToken, dependencies)
	refreshInflight.set(refreshToken, pending)
	try {
		const tokenSet = await pending
		latestRefresh = { oldToken: refreshToken, tokenSet }
		return tokenSet
	} finally {
		if (refreshInflight.get(refreshToken) === pending) refreshInflight.delete(refreshToken)
	}
}

async function requestTokenWithRetry(
	refreshToken: string,
	dependencies: RefreshDependencies,
): Promise<TokenSet> {
	const sleep =
		dependencies.sleep ??
		((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
	for (let attempt = 0; attempt <= 2; attempt += 1) {
		if (attempt > 0) await sleep(500 * 2 ** (attempt - 1))
		const outcome = await Effect.runPromise(
			Effect.result(
				requestToken(
					'refresh',
					encodeRefreshRequest({
						grant_type: 'refresh_token',
						refresh_token: refreshToken,
						client_id: CLIENT_ID,
					}),
					dependencies,
				),
			),
		)
		if (Result.isSuccess(outcome)) return outcome.success
		if (!outcome.failure.transient || attempt === 2) throw outcome.failure
	}
	throw new OAuthError({
		operation: 'refresh',
		message: 'The OAuth token refresh exhausted its retry budget.',
		transient: false,
	})
}

function requestToken(
	operation: TokenOperation,
	body: string,
	dependencies: TokenDependencies,
): Effect.Effect<TokenSet, OAuthError> {
	const transport = dependencies.transport ?? fetch
	return Effect.gen(function* () {
		const response = yield* Effect.tryPromise({
			try: () =>
				transport(TOKEN_URL, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Accept: 'application/json, text/plain, */*',
						'User-Agent': 'axios/1.13.6',
					},
					body,
				}),
			catch: () =>
				new OAuthError({
					operation,
					message: `Unable to reach the OAuth token endpoint during ${operation}.`,
					transient: true,
				}),
		})
		const responseBody = yield* Effect.tryPromise({
			try: () => response.text(),
			catch: () =>
				new OAuthError({
					operation,
					message: `Unable to read the OAuth token response during ${operation}.`,
					status: response.status,
					transient: response.status >= 500,
				}),
		})
		if (!response.ok) {
			return yield* new OAuthError({
				operation,
				message: `The OAuth token endpoint rejected ${operation} with HTTP ${response.status}.`,
				status: response.status,
				transient: response.status >= 500,
			})
		}
		const decoded = yield* Schema.decodeUnknownEffect(TokenResponseJson)(responseBody).pipe(
			Effect.mapError(
				() =>
					new OAuthError({
						operation,
						message: `The OAuth token endpoint returned an invalid ${operation} response.`,
						status: response.status,
						transient: false,
					}),
			),
		)
		if (!Number.isSafeInteger(decoded.expires_in) || decoded.expires_in <= 0) {
			return yield* new OAuthError({
				operation,
				message: `The OAuth token endpoint returned an invalid ${operation} expiry.`,
				status: response.status,
				transient: false,
			})
		}
		return {
			refresh: decoded.refresh_token,
			access: decoded.access_token,
			expires: (dependencies.now ?? Date.now)() + decoded.expires_in * 1000,
		}
	})
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
	return typeof input === 'object' && input !== null && !Array.isArray(input)
}
