import { Effect, Result } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { CODE_CALLBACK_URL, MAX_METADATA_KEY, MAX_METHOD_ID } from '../src/constants'
import {
	authorize,
	exchange,
	isMarkedMaxCredential,
	maxCredential,
	type OAuthCredential,
	type OAuthTransport,
	parseCallbackInput,
	refreshCredential,
} from '../src/oauth'

function response(refresh = 'refresh-new', access = 'access-new', expiresIn = 3600) {
	return new Response(
		JSON.stringify({
			refresh_token: refresh,
			access_token: access,
			expires_in: expiresIn,
		}),
		{ status: 200 },
	)
}

function credential(
	refresh: string,
	metadata?: Readonly<Record<string, unknown>>,
): OAuthCredential {
	return {
		type: 'oauth',
		methodID: MAX_METHOD_ID,
		refresh,
		access: 'access-old',
		expires: 0,
		...(metadata === undefined ? {} : { metadata }),
	}
}

describe('PKCE authorization and callback exchange', () => {
	it('creates the exact hosted Max authorization profile and PKCE challenge', async () => {
		const authorization = await Effect.runPromise(authorize())
		const url = new URL(authorization.url)
		expect(url.origin).toBe('https://claude.ai')
		expect(url.pathname).toBe('/oauth/authorize')
		expect(url.searchParams.get('redirect_uri')).toBe(CODE_CALLBACK_URL)
		expect(url.searchParams.get('code_challenge_method')).toBe('S256')
		expect(url.searchParams.get('state')).toBe(authorization.state)
		expect(authorization.verifier).toMatch(/^[A-Za-z0-9_-]{86}$/)
		expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
	})

	it('parses full URLs, query strings, and code#state without accepting incomplete input', () => {
		expect(parseCallbackInput(`${CODE_CALLBACK_URL}?code=full-code&state=full-state`)).toEqual({
			code: 'full-code',
			state: 'full-state',
		})
		expect(parseCallbackInput('code=query-code&state=query-state')).toEqual({
			code: 'query-code',
			state: 'query-state',
		})
		expect(parseCallbackInput('hash-code#hash-state')).toEqual({
			code: 'hash-code',
			state: 'hash-state',
		})
		expect(parseCallbackInput('code-without-state')).toBeUndefined()
	})

	it('strictly verifies state before contacting the token endpoint', async () => {
		const transport = vi.fn<OAuthTransport>(() => Promise.resolve(response()))
		const result = await Effect.runPromise(
			Effect.result(
				exchange('code#wrong-state', 'verifier', CODE_CALLBACK_URL, 'expected-state', {
					transport,
				}),
			),
		)
		expect(Result.isFailure(result)).toBe(true)
		if (Result.isFailure(result)) expect(result.failure.message).toMatch(/state did not match/)
		expect(transport).not.toHaveBeenCalled()
	})

	it('validates exchange responses and returns deterministic expiry', async () => {
		let requestBody = ''
		const transport: OAuthTransport = (_input, init) => {
			requestBody = String(init?.body ?? '')
			return Promise.resolve(response('exchange-refresh', 'exchange-access', 60))
		}
		const result = await Effect.runPromise(
			exchange('exchange-code#expected-state', 'verifier', CODE_CALLBACK_URL, 'expected-state', {
				transport,
				now: () => 1_000,
			}),
		)
		expect(result).toEqual({
			refresh: 'exchange-refresh',
			access: 'exchange-access',
			expires: 61_000,
		})
		expect(JSON.parse(requestBody)).toMatchObject({
			code: 'exchange-code',
			state: 'expected-state',
			redirect_uri: CODE_CALLBACK_URL,
			code_verifier: 'verifier',
		})
	})

	it.each([
		['HTTP failure', new Response('secret response must not surface', { status: 401 })],
		['invalid JSON', new Response('{', { status: 200 })],
		[
			'invalid fields',
			new Response(JSON.stringify({ refresh_token: '', access_token: 'access', expires_in: -1 }), {
				status: 200,
			}),
		],
	])('fails safely on %s', async (_name, tokenResponse) => {
		const transport: OAuthTransport = () => Promise.resolve(tokenResponse)
		const result = await Effect.runPromise(
			Effect.result(exchange('code#state', 'verifier', CODE_CALLBACK_URL, 'state', { transport })),
		)
		expect(Result.isFailure(result)).toBe(true)
		if (Result.isFailure(result)) expect(result.failure.message).not.toContain('secret response')
	})

	it('marks successful credentials with namespaced Max metadata', () => {
		const result = maxCredential({ refresh: 'refresh', access: 'access', expires: 123 })
		expect(result.methodID).toBe(MAX_METHOD_ID)
		expect(result.metadata).toEqual({
			[MAX_METADATA_KEY]: { mode: 'max', profile: 'claude-code-2.1.87' },
		})
		expect(isMarkedMaxCredential(result)).toBe(true)
		expect(isMarkedMaxCredential({ ...result, metadata: {} })).toBe(false)
	})
})

describe('race-safe refresh', () => {
	it('singleflights concurrent same-token refreshes and replays a completed result to late stale callers', async () => {
		const oldToken = `concurrent-${crypto.randomUUID()}`
		let release: ((value: Response) => void) | undefined
		const pending = new Promise<Response>((resolve) => {
			release = resolve
		})
		let calls = 0
		const transport: OAuthTransport = () => {
			calls += 1
			return pending
		}
		const callers = Array.from({ length: 5 }, () =>
			Effect.runPromise(refreshCredential(credential(oldToken), { transport, now: () => 10_000 })),
		)
		await vi.waitFor(() => expect(calls).toBe(1))
		if (!release) throw new Error('Refresh response was not requested')
		release(response('rotated-refresh', 'fresh-access', 60))
		const results = await Promise.all(callers)
		expect(results.map((item) => item.access)).toEqual(Array(5).fill('fresh-access'))
		expect(calls).toBe(1)

		const late = await Effect.runPromise(
			refreshCredential(credential(oldToken), { transport, now: () => 20_000 }),
		)
		expect(late).toMatchObject({ refresh: 'rotated-refresh', access: 'fresh-access' })
		expect(calls).toBe(1)
	})

	it('preserves each caller methodID and metadata around a shared token result', async () => {
		const oldToken = `metadata-${crypto.randomUUID()}`
		let release: ((value: Response) => void) | undefined
		const pending = new Promise<Response>((resolve) => {
			release = resolve
		})
		const transport: OAuthTransport = () => pending
		const first = credential(oldToken, { location: 'first', [MAX_METADATA_KEY]: { mode: 'max' } })
		const second = { ...credential(oldToken, { location: 'second' }), methodID: 'second-method' }
		const firstResult = Effect.runPromise(refreshCredential(first, { transport }))
		const secondResult = Effect.runPromise(refreshCredential(second, { transport }))
		await Promise.resolve()
		if (!release) throw new Error('Refresh response was not requested')
		release(response())

		expect(await firstResult).toMatchObject({ methodID: MAX_METHOD_ID, metadata: first.metadata })
		expect(await secondResult).toMatchObject({
			methodID: 'second-method',
			metadata: second.metadata,
		})
	})

	it('clears failed singleflight entries so a later attempt can succeed', async () => {
		const oldToken = `failure-${crypto.randomUUID()}`
		let calls = 0
		const transport: OAuthTransport = () => {
			calls += 1
			return Promise.resolve(calls === 1 ? new Response('rejected', { status: 400 }) : response())
		}
		const failed = await Effect.runPromise(
			Effect.result(refreshCredential(credential(oldToken), { transport })),
		)
		expect(Result.isFailure(failed)).toBe(true)
		const succeeded = await Effect.runPromise(
			refreshCredential(credential(oldToken), { transport }),
		)
		expect(succeeded.access).toBe('access-new')
		expect(calls).toBe(2)
	})

	it('retries bounded transient failures without retrying permanent failures', async () => {
		const oldToken = `retry-${crypto.randomUUID()}`
		let calls = 0
		const sleeps: number[] = []
		const transport: OAuthTransport = () => {
			calls += 1
			return Promise.resolve(calls === 1 ? new Response('temporary', { status: 500 }) : response())
		}
		const refreshed = await Effect.runPromise(
			refreshCredential(credential(oldToken), {
				transport,
				sleep: (milliseconds) => {
					sleeps.push(milliseconds)
					return Promise.resolve()
				},
			}),
		)
		expect(refreshed.access).toBe('access-new')
		expect(calls).toBe(2)
		expect(sleeps).toEqual([500])
	})
})
