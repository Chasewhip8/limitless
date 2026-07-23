import type { Plugin } from '@opencode-ai/plugin/v2/effect'
import type { CatalogDraft } from '@opencode-ai/plugin/v2/effect/catalog'
import type { IntegrationDraft } from '@opencode-ai/plugin/v2/effect/integration'
import { Effect, Stream } from 'effect'
import { describe, expect, test } from 'vitest'
import { resolvePluginConfigs } from '../index'
import {
	ANTHROPIC_INTEGRATION_ID,
	ANTHROPIC_OAUTH_METHOD_ID,
	anthropicOAuthMethod,
	configureAnthropicSubscriptionSdk,
	isLimitlessAnthropicOAuthCredential,
	normalizeAnthropicSubscriptionAuthConfig,
	registerAnthropicOAuthMethod,
	registerAnthropicSubscriptionAuth,
	transformAnthropicOAuthCatalog,
} from '../integrations/anthropic-auth/index'
import { makeAnthropicOAuthFetch } from '../integrations/anthropic-auth/provider-boundary'
import {
	CLAUDE_CODE_IDENTITY,
	CLAUDE_CODE_USER_AGENT,
	REQUIRED_ANTHROPIC_OAUTH_BETAS,
	rewriteAnthropicRequestBody,
	rewriteAnthropicUrl,
	transformAnthropicResponse,
} from '../integrations/anthropic-auth/transform'

const tokenResponse = (access: string, refresh: string) =>
	new Response(
		JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3_600 }),
		{ status: 200, headers: { 'content-type': 'application/json' } },
	)

describe('native Anthropic subscription OAuth', () => {
	test('defaults on, propagates plugin options, and supports an opt-out without a connection', async () => {
		await expect(
			Effect.runPromise(normalizeAnthropicSubscriptionAuthConfig(undefined)),
		).resolves.toEqual({ enabled: true })
		await expect(
			Effect.runPromise(
				normalizeAnthropicSubscriptionAuthConfig({
					anthropicSubscriptionAuth: { enable: false },
				}),
			),
		).resolves.toEqual({ enabled: false })

		const configs = await Effect.runPromise(
			resolvePluginConfigs({ anthropicSubscriptionAuth: { enable: false }, lsp: {} }),
		)
		expect(configs.anthropicSubscriptionAuthConfig.enabled).toBe(false)

		const registrations: Array<unknown> = []
		const draft = {
			method: { update: (registration: unknown) => registrations.push(registration) },
		} as unknown as IntegrationDraft
		registerAnthropicOAuthMethod(draft, { enabled: false })
		expect(registrations).toEqual([])

		let activeConnectionChecks = 0
		const disabledContext = {
			integration: {
				connection: {
					active: () =>
						Effect.sync(() => {
							activeConnectionChecks += 1
							return undefined
						}),
				},
			},
		} as unknown as Plugin.Context
		await expect(
			Effect.runPromise(
				Effect.scoped(registerAnthropicSubscriptionAuth(disabledContext, { enabled: false })),
			),
		).resolves.toBeUndefined()
		expect(activeConnectionChecks).toBe(1)
	})

	test('registers only Claude Pro/Max and exchanges the native code callback', async () => {
		const requests: Array<{ url: string; body: Record<string, string> }> = []
		const fetcher: typeof fetch = async (input, init) => {
			requests.push({
				url: input.toString(),
				body: JSON.parse(String(init?.body)) as Record<string, string>,
			})
			return tokenResponse('access-1', 'refresh-1')
		}
		const registration = anthropicOAuthMethod(fetcher, () => 10_000)
		const authorization = await Effect.runPromise(Effect.scoped(registration.authorize({})))
		const url = new URL(authorization.url)

		expect(registration.integrationID).toBe(ANTHROPIC_INTEGRATION_ID)
		expect(registration.method).toEqual({
			id: ANTHROPIC_OAUTH_METHOD_ID,
			type: 'oauth',
			label: 'Claude Pro/Max subscription',
		})
		expect(url.origin).toBe('https://claude.ai')
		expect(url.searchParams.get('code_challenge_method')).toBe('S256')
		expect(url.searchParams.get('code_challenge')).toHaveLength(43)
		expect(authorization.mode).toBe('code')
		if (authorization.mode !== 'code') throw new Error('Expected a code callback')
		const state = url.searchParams.get('state')
		expect(state).toHaveLength(32)
		const credential = await Effect.runPromise(authorization.callback(`oauth-code#${state}`))

		expect(credential).toEqual({
			type: 'oauth',
			methodID: ANTHROPIC_OAUTH_METHOD_ID,
			refresh: 'refresh-1',
			access: 'access-1',
			expires: 3_610_000,
		})
		expect(requests).toHaveLength(1)
		expect(requests[0]?.body).toEqual(
			expect.objectContaining({
				code: 'oauth-code',
				state,
				grant_type: 'authorization_code',
			}),
		)
		expect(requests[0]?.body.code_verifier).toHaveLength(86)
	})

	test('returns rotated credentials from the native refresh callback', async () => {
		const requests: Array<Record<string, string>> = []
		const fetcher: typeof fetch = async (_input, init) => {
			requests.push(JSON.parse(String(init?.body)) as Record<string, string>)
			return tokenResponse('access-2', 'refresh-2')
		}
		const registration = anthropicOAuthMethod(fetcher, () => 50_000)
		if (registration.refresh === undefined) throw new Error('Expected refresh callback')
		const refreshed = await Effect.runPromise(
			registration.refresh({
				type: 'oauth',
				methodID: ANTHROPIC_OAUTH_METHOD_ID,
				refresh: 'refresh-1',
				access: 'access-1',
				expires: 1,
				metadata: { connection: 'kept' },
			}),
		)

		expect(requests).toEqual([
			{
				grant_type: 'refresh_token',
				refresh_token: 'refresh-1',
				client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
			},
		])
		expect(refreshed).toEqual({
			type: 'oauth',
			methodID: ANTHROPIC_OAUTH_METHOD_ID,
			refresh: 'refresh-2',
			access: 'access-2',
			expires: 3_650_000,
			metadata: { connection: 'kept' },
		})
	})

	test('shares an in-flight refresh for the same refresh token', async () => {
		let requestCount = 0
		let releaseRequest: (() => void) | undefined
		let markStarted: (() => void) | undefined
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		const release = new Promise<void>((resolve) => {
			releaseRequest = resolve
		})
		const registration = anthropicOAuthMethod(async () => {
			requestCount += 1
			markStarted?.()
			await release
			return tokenResponse('shared-access', 'rotated-refresh')
		})
		if (registration.refresh === undefined) throw new Error('Expected refresh callback')
		const current = {
			type: 'oauth' as const,
			methodID: ANTHROPIC_OAUTH_METHOD_ID,
			refresh: 'shared-refresh',
			access: 'expired',
			expires: 1,
		}

		const results = Promise.all([
			Effect.runPromise(registration.refresh(current)),
			Effect.runPromise(registration.refresh(current)),
		])
		await started
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(requestCount).toBe(1)
		releaseRequest?.()

		await expect(results).resolves.toEqual([
			expect.objectContaining({ access: 'shared-access', refresh: 'rotated-refresh' }),
			expect.objectContaining({ access: 'shared-access', refresh: 'rotated-refresh' }),
		])
		expect(requestCount).toBe(1)
	})

	test('refreshes different tokens independently', async () => {
		const started = new Map<string, () => void>()
		const released = new Map<string, Promise<void>>()
		const release = new Map<string, () => void>()
		for (const token of ['refresh-a', 'refresh-b']) {
			released.set(
				token,
				new Promise<void>((resolve) => {
					release.set(token, resolve)
				}),
			)
		}
		const bothStarted = Promise.all(
			['refresh-a', 'refresh-b'].map(
				(token) =>
					new Promise<void>((resolve) => {
						started.set(token, resolve)
					}),
			),
		)
		const requests: Array<string> = []
		const registration = anthropicOAuthMethod(async (_input, init) => {
			const token = (JSON.parse(String(init?.body)) as { refresh_token: string }).refresh_token
			requests.push(token)
			started.get(token)?.()
			await released.get(token)
			return tokenResponse(`access-for-${token}`, `rotated-${token}`)
		})
		if (registration.refresh === undefined) throw new Error('Expected refresh callback')
		const refresh = registration.refresh
		const results = Promise.all(
			['refresh-a', 'refresh-b'].map((token) =>
				Effect.runPromise(
					refresh({
						type: 'oauth',
						methodID: ANTHROPIC_OAUTH_METHOD_ID,
						refresh: token,
						access: 'expired',
						expires: 1,
					}),
				),
			),
		)

		await bothStarted
		expect([...requests].sort()).toEqual(['refresh-a', 'refresh-b'])
		release.get('refresh-a')?.()
		release.get('refresh-b')?.()
		await expect(results).resolves.toHaveLength(2)
	})

	test('clears a failed shared refresh so a later call can retry', async () => {
		let requestCount = 0
		let releaseFailure: (() => void) | undefined
		let markStarted: (() => void) | undefined
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		const failureReleased = new Promise<void>((resolve) => {
			releaseFailure = resolve
		})
		const registration = anthropicOAuthMethod(async () => {
			requestCount += 1
			if (requestCount === 1) {
				markStarted?.()
				await failureReleased
				return new Response('invalid grant', { status: 400 })
			}
			return tokenResponse('recovered-access', 'recovered-refresh')
		})
		if (registration.refresh === undefined) throw new Error('Expected refresh callback')
		const current = {
			type: 'oauth' as const,
			methodID: ANTHROPIC_OAUTH_METHOD_ID,
			refresh: 'failed-refresh',
			access: 'expired',
			expires: 1,
		}
		const sharedFailure = Promise.allSettled([
			Effect.runPromise(registration.refresh(current)),
			Effect.runPromise(registration.refresh(current)),
		])
		await started
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(requestCount).toBe(1)
		releaseFailure?.()
		const failures = await sharedFailure
		expect(failures.every((result) => result.status === 'rejected')).toBe(true)
		expect(requestCount).toBe(1)

		await expect(Effect.runPromise(registration.refresh(current))).resolves.toEqual(
			expect.objectContaining({ access: 'recovered-access', refresh: 'recovered-refresh' }),
		)
		expect(requestCount).toBe(2)
	})

	test('rejects a mismatched OAuth state before token exchange', async () => {
		let called = false
		const registration = anthropicOAuthMethod(async () => {
			called = true
			return tokenResponse('unused', 'unused')
		})
		const authorization = await Effect.runPromise(Effect.scoped(registration.authorize({})))
		if (authorization.mode !== 'code') throw new Error('Expected a code callback')
		await expect(Effect.runPromise(authorization.callback('code#wrong-state'))).rejects.toThrow(
			'invalid',
		)
		expect(called).toBe(false)
	})
})

describe('Anthropic OAuth request compatibility', () => {
	test('rewrites headers, URL, prompt, tools, and leaves provider fields intact', async () => {
		const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
		const upstream: typeof fetch = async (input, init) => {
			requests.push({
				url: input.toString(),
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			})
			return new Response(
				'data: {"type":"content_block_start","content_block":{"name":"mcp_Bash"}}\n\n',
				{ headers: { 'content-type': 'text/event-stream' } },
			)
		}
		const oauthFetch = makeAnthropicOAuthFetch('oauth-access', upstream)
		const response = await oauthFetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'x-api-key': 'must-be-removed',
				'anthropic-beta': 'custom-beta',
			},
			body: JSON.stringify({
				model: 'claude-test',
				max_tokens: 1_024,
				temperature: 0.2,
				top_p: 0.9,
				thinking: { type: 'enabled', budget_tokens: 256 },
				output_config: { effort: 'high' },
				system:
					'You are OpenCode, the best coding agent.\n\nKeep this instruction.\n\nHere is some useful information about the environment you are running in:',
				tools: [{ name: 'bash', description: 'Run a command', input_schema: {} }],
				messages: [
					{ role: 'user', content: 'hello world' },
					{ role: 'assistant', content: [{ type: 'tool_use', name: 'bash', input: {} }] },
				],
			}),
		})

		expect(requests[0]?.url).toBe('https://api.anthropic.com/v1/messages?beta=true')
		expect(requests[0]?.headers.get('authorization')).toBe('Bearer oauth-access')
		expect(requests[0]?.headers.get('x-api-key')).toBeNull()
		expect(requests[0]?.headers.get('user-agent')).toBe(CLAUDE_CODE_USER_AGENT)
		for (const beta of [...REQUIRED_ANTHROPIC_OAUTH_BETAS, 'custom-beta']) {
			expect(requests[0]?.headers.get('anthropic-beta')).toContain(beta)
		}
		const body = requests[0]?.body
		expect(body).toEqual(
			expect.objectContaining({
				model: 'claude-test',
				max_tokens: 1_024,
				temperature: 0.2,
				top_p: 0.9,
				thinking: { type: 'enabled', budget_tokens: 256 },
				output_config: { effort: 'high' },
			}),
		)
		expect(body?.tools).toEqual([
			{ name: 'mcp_Bash', description: 'Run a command', input_schema: {} },
		])
		expect(body?.messages).toEqual([
			{ role: 'user', content: 'hello world' },
			{ role: 'assistant', content: [{ type: 'tool_use', name: 'mcp_Bash', input: {} }] },
		])
		const system = body?.system as Array<{ text: string }>
		expect(system[0]?.text).toMatch(/^x-anthropic-billing-header:/u)
		expect(system[1]?.text).toBe(CLAUDE_CODE_IDENTITY)
		expect(system[2]?.text).toContain('Keep this instruction.')
		expect(system[2]?.text).toContain('Environment context you are running in:')
		expect(system.map((block) => block.text).join('\n')).not.toContain('You are OpenCode')
		expect(await response.text()).toContain('"name": "bash"')
	})

	test('handles tool names split across response chunks without buffering later events', async () => {
		const encoder = new TextEncoder()
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('data: {"name":"mcp_'))
				controller.enqueue(encoder.encode('Read_file"}\n'))
				controller.enqueue(encoder.encode('data: {"name":"mcp_StructuredOutput"}\n'))
				controller.close()
			},
		})
		const response = transformAnthropicResponse(
			new Response(source, { status: 202, headers: { 'x-test': 'kept' } }),
		)

		expect(response.status).toBe(202)
		expect(response.headers.get('x-test')).toBe('kept')
		expect(await response.text()).toBe(
			'data: {"name": "read_file"}\ndata: {"name": "StructuredOutput"}\n',
		)
	})

	test('leaves invalid JSON and existing beta query values unchanged', () => {
		expect(rewriteAnthropicRequestBody('not-json')).toBe('not-json')
		expect(rewriteAnthropicUrl('https://api.anthropic.com/v1/messages?beta=false').toString()).toBe(
			'https://api.anthropic.com/v1/messages?beta=false',
		)
	})
})

describe('Anthropic provider isolation', () => {
	function catalogDraft() {
		const anthropicProvider = {
			id: 'anthropic',
			name: 'Anthropic',
			package: 'aisdk:@ai-sdk/anthropic',
			disabled: false,
		}
		const openaiProvider = {
			id: 'openai',
			name: 'OpenAI',
			package: 'aisdk:@ai-sdk/openai',
			disabled: false,
		}
		const anthropicModel = {
			id: 'claude-test',
			package: undefined as string | undefined,
			cost: [{ input: 1, output: 1 }],
		}
		const openaiModel = { id: 'gpt-test', package: undefined, cost: [{ input: 1, output: 1 }] }
		const providers = new Map([
			[
				'anthropic',
				{ provider: anthropicProvider, models: new Map([['claude-test', anthropicModel]]) },
			],
			['openai', { provider: openaiProvider, models: new Map([['gpt-test', openaiModel]]) }],
		])
		const draft = {
			provider: {
				get: (id: string) => providers.get(id),
				update: (id: string, update: (provider: typeof anthropicProvider) => void) => {
					const provider = providers.get(id)?.provider
					if (provider !== undefined) update(provider)
				},
			},
			model: {
				update: (
					providerID: string,
					modelID: string,
					update: (model: typeof anthropicModel) => void,
				) => {
					const model = providers.get(providerID)?.models.get(modelID)
					if (model !== undefined) update(model)
				},
			},
		} as unknown as CatalogDraft
		return { draft, anthropicProvider, openaiProvider, anthropicModel, openaiModel }
	}

	test('does not alter API-key or non-Anthropic provider behavior', () => {
		const values = catalogDraft()
		transformAnthropicOAuthCatalog(values.draft, false)
		expect(values.anthropicProvider.package).toBe('aisdk:@ai-sdk/anthropic')
		expect(values.anthropicModel.cost).toEqual([{ input: 1, output: 1 }])
		expect(values.openaiProvider.package).toBe('aisdk:@ai-sdk/openai')
		expect(values.openaiModel.cost).toEqual([{ input: 1, output: 1 }])
		expect(isLimitlessAnthropicOAuthCredential({ type: 'key', key: 'sk-ant-api' })).toBe(false)
	})

	test('adapts only the Anthropic catalog after this OAuth method connects', () => {
		const values = catalogDraft()
		transformAnthropicOAuthCatalog(values.draft, true)
		expect(values.anthropicProvider.package).toBe('aisdk:@ai-sdk/anthropic')
		expect(values.anthropicModel.cost).toEqual([])
		expect(values.openaiProvider.package).toBe('aisdk:@ai-sdk/openai')
		expect(values.openaiModel.cost).toEqual([{ input: 1, output: 1 }])
		expect(
			isLimitlessAnthropicOAuthCredential({
				type: 'oauth',
				methodID: ANTHROPIC_OAUTH_METHOD_ID,
			}),
		).toBe(true)
	})

	test('blocks only Anthropic while credential state is unsafe', () => {
		const values = catalogDraft()
		transformAnthropicOAuthCatalog(values.draft, false, true)
		expect(values.anthropicProvider.disabled).toBe(true)
		expect(values.openaiProvider.disabled).toBe(false)
	})

	test('blocks a lingering subscription credential when the adapter is disabled', async () => {
		let catalogTransform: ((draft: CatalogDraft) => void) | undefined
		let reloads = 0
		const context = {
			integration: {
				connection: {
					active: () => Effect.succeed({ id: 'connection' }),
					resolve: () => Effect.succeed({ type: 'oauth', methodID: ANTHROPIC_OAUTH_METHOD_ID }),
				},
			},
			catalog: {
				transform: (transform: (draft: CatalogDraft) => void) =>
					Effect.sync(() => {
						catalogTransform = transform
					}),
				reload: () =>
					Effect.sync(() => {
						reloads += 1
					}),
			},
		} as unknown as Plugin.Context

		await Effect.runPromise(
			Effect.scoped(registerAnthropicSubscriptionAuth(context, { enabled: false })),
		)
		const values = catalogDraft()
		catalogTransform?.(values.draft)
		expect(values.anthropicProvider.disabled).toBe(true)
		expect(reloads).toBe(1)
	})

	test('fails closed on startup resolution errors and retries on a connection event', async () => {
		let catalogTransform: ((draft: CatalogDraft) => void) | undefined
		let resolutionWorks = false
		let reloads = 0
		let emitConnectionUpdate: ((event: unknown) => void) | undefined
		const connectionUpdate = new Promise<unknown>((resolve) => {
			emitConnectionUpdate = resolve
		})
		let markReloaded: (() => void) | undefined
		const eventReloaded = new Promise<void>((resolve) => {
			markReloaded = resolve
		})
		const context = {
			integration: {
				transform: (transform: (draft: IntegrationDraft) => void) =>
					Effect.sync(() => {
						transform({ method: { update: () => undefined } } as unknown as IntegrationDraft)
					}),
				connection: {
					active: () => Effect.succeed({ id: 'connection' }),
					resolve: () =>
						resolutionWorks
							? Effect.succeed({
									type: 'oauth',
									methodID: ANTHROPIC_OAUTH_METHOD_ID,
								})
							: Effect.fail('credential store unavailable'),
				},
			},
			catalog: {
				transform: (transform: (draft: CatalogDraft) => void) =>
					Effect.sync(() => {
						catalogTransform = transform
					}),
				reload: () =>
					Effect.sync(() => {
						reloads += 1
						if (reloads === 2) markReloaded?.()
					}),
			},
			aisdk: { hook: () => Effect.void },
			event: {
				subscribe: () =>
					Stream.fromEffect(Effect.promise(() => connectionUpdate)).pipe(
						Stream.concat(Stream.never),
					),
			},
		} as unknown as Plugin.Context

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* registerAnthropicSubscriptionAuth(context)
					const initiallyBlocked = catalogDraft()
					catalogTransform?.(initiallyBlocked.draft)
					expect(initiallyBlocked.anthropicProvider.disabled).toBe(true)
					expect(reloads).toBe(1)

					resolutionWorks = true
					emitConnectionUpdate?.({
						type: 'integration.connection.updated',
						data: { integrationID: ANTHROPIC_INTEGRATION_ID },
					})
					yield* Effect.promise(() => eventReloaded)
					const connected = catalogDraft()
					catalogTransform?.(connected.draft)
					expect(connected.anthropicProvider.disabled).toBe(false)
					expect(connected.anthropicProvider.package).toBe('aisdk:@ai-sdk/anthropic')
				}),
			),
		)
	})
})

describe('Anthropic AI SDK boundary', () => {
	test('replaces native Anthropic API-key setup for an active subscription', async () => {
		let requestHeaders: Headers | undefined
		const upstream: typeof fetch = async (_input, init) => {
			requestHeaders = new Headers(init?.headers)
			return new Response('ok')
		}
		const event = {
			model: {} as never,
			package: '@ai-sdk/anthropic',
			options: { apiKey: 'oauth-access', fetch: upstream },
		} as Parameters<typeof configureAnthropicSubscriptionSdk>[0]

		configureAnthropicSubscriptionSdk(event, true)
		expect(event.options.apiKey).toBeUndefined()
		expect(event.options.authToken).toBe('oauth-access')
		expect(event.sdk).toBeDefined()
		await event.options.fetch('https://api.anthropic.com/v1/messages', { method: 'GET' })
		expect(requestHeaders?.get('authorization')).toBe('Bearer oauth-access')
		expect(requestHeaders?.get('x-api-key')).toBeNull()
	})

	test('leaves native Anthropic API-key setup untouched without an active subscription', () => {
		const options = { apiKey: 'normal-api-key' }
		const event = {
			model: {} as never,
			package: '@ai-sdk/anthropic',
			options,
		} as Parameters<typeof configureAnthropicSubscriptionSdk>[0]
		configureAnthropicSubscriptionSdk(event, false)
		expect(event.options).toBe(options)
		expect(event.options).toEqual({ apiKey: 'normal-api-key' })
		expect(event.sdk).toBeUndefined()
	})
})
