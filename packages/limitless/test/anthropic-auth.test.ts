import type { createAnthropic } from '@ai-sdk/anthropic'
import type { Plugin } from '@opencode-ai/plugin/v2/effect'
import type { AISDKHooks } from '@opencode-ai/plugin/v2/effect/aisdk'
import type { CatalogDraft } from '@opencode-ai/plugin/v2/effect/catalog'
import type { IntegrationDraft } from '@opencode-ai/plugin/v2/effect/integration'
import type { SessionHooks } from '@opencode-ai/plugin/v2/effect/session'
import { Effect, Stream } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createLimitlessAnthropicBootstrap, resolvePluginConfigs } from '../index'
import {
	ANTHROPIC_INTEGRATION_ID,
	ANTHROPIC_OAUTH_METHOD_ID,
	ANTHROPIC_OAUTH_PROVIDER_PACKAGE,
	anthropicOAuthMethod,
	isLimitlessAnthropicOAuthCredential,
	normalizeAnthropicSubscriptionAuthConfig,
	registerAnthropicOAuthMethod,
	registerAnthropicSubscriptionAuth,
	transformAnthropicOAuthCatalog,
} from '../integrations/anthropic-auth/index'

const validCredential = (access = 'oauth-access', refresh = 'oauth-refresh') => ({
	type: 'oauth' as const,
	methodID: ANTHROPIC_OAUTH_METHOD_ID,
	refresh,
	access,
	expires: Date.now() + 3_600_000,
})

const tokenResponse = (access: string, refresh: string) =>
	new Response(
		JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3_600 }),
		{ status: 200, headers: { 'content-type': 'application/json' } },
	)

afterEach(() => {
	vi.restoreAllMocks()
})

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
				...validCredential('access-1', 'refresh-1'),
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
		const current = { ...validCredential('expired', 'shared-refresh'), expires: 1 }

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
				Effect.runPromise(refresh({ ...validCredential('expired', token), expires: 1 })),
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
		const current = { ...validCredential('expired', 'failed-refresh'), expires: 1 }
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

describe('Anthropic provider isolation', () => {
	test('does not alter API-key or non-Anthropic provider behavior', () => {
		const values = catalogDraft()
		transformAnthropicOAuthCatalog(values.draft, false)
		expect(values.anthropicProvider.package).toBe('aisdk:@ai-sdk/anthropic')
		expect(values.anthropicModel.cost).toEqual([{ input: 1, output: 1 }])
		expect(values.openaiProvider.package).toBe('aisdk:@ai-sdk/openai')
		expect(values.openaiModel.cost).toEqual([{ input: 1, output: 1 }])
		expect(isLimitlessAnthropicOAuthCredential({ type: 'key', key: 'sk-ant-api' })).toBe(false)
	})

	test('moves every connected subscription model to the unique synthetic package', () => {
		const values = catalogDraft()
		transformAnthropicOAuthCatalog(values.draft, true)
		expect(values.anthropicProvider.package).toBe(ANTHROPIC_OAUTH_PROVIDER_PACKAGE)
		expect(values.anthropicModel.cost).toEqual([])
		expect(values.openaiProvider.package).toBe('aisdk:@ai-sdk/openai')
		expect(values.openaiModel.cost).toEqual([{ input: 1, output: 1 }])
		expect(isLimitlessAnthropicOAuthCredential(validCredential())).toBe(true)
		expect(
			isLimitlessAnthropicOAuthCredential({
				type: 'oauth',
				methodID: ANTHROPIC_OAUTH_METHOD_ID,
			}),
		).toBe(false)
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
					resolve: () => Effect.succeed(validCredential()),
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

	test('fails closed for malformed or unknown OAuth credentials', async () => {
		let catalogTransform: ((draft: CatalogDraft) => void) | undefined
		const context = {
			integration: {
				transform: () => Effect.void,
				connection: {
					active: () => Effect.succeed({ id: 'connection' }),
					resolve: () =>
						Effect.succeed({ type: 'oauth', methodID: 'unknown-method', access: 'token' }),
				},
			},
			catalog: {
				transform: (transform: (draft: CatalogDraft) => void) =>
					Effect.sync(() => {
						catalogTransform = transform
					}),
				reload: () => Effect.void,
			},
			aisdk: { hook: () => Effect.void },
			session: { hook: () => Effect.void },
			event: { subscribe: () => Stream.never },
		} as unknown as Plugin.Context

		await Effect.runPromise(Effect.scoped(registerAnthropicSubscriptionAuth(context)))
		const values = catalogDraft()
		catalogTransform?.(values.draft)
		expect(values.anthropicProvider.disabled).toBe(true)
		expect(values.openaiProvider.disabled).toBe(false)
	})

	test('fails closed on resolution errors and retries on a connection event', async () => {
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
							? Effect.succeed(validCredential())
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
			session: { hook: () => Effect.void },
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
					expect(connected.anthropicProvider.package).toBe(ANTHROPIC_OAUTH_PROVIDER_PACKAGE)
				}),
			),
		)
	})
})

const responseSse = [
	'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-test","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":5}}}',
	'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"mcp_Bash","input":{}}}',
	'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
	'data: {"type":"content_block_stop","index":0}',
	'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":1}}',
	'data: {"type":"message_stop"}',
	'',
].join('\n\n')

describe('published Anthropic loader and AI SDK integration', () => {
	test('initializes the synthetic package and applies the complete OAuth wire adapter', async () => {
		const providerPackage = 'aisdk:file:///nix/store/limitless-test/limitless.js'
		let catalogTransform: ((draft: CatalogDraft) => void) | undefined
		let sdkHook: ((event: AISDKHooks['sdk']) => Effect.Effect<void>) | undefined
		let sessionHook: ((event: SessionHooks['context']) => Effect.Effect<void>) | undefined
		let credentialResolutions = 0
		const credential = validCredential()
		const context = {
			integration: {
				transform: (transform: (draft: IntegrationDraft) => void) =>
					Effect.sync(() => {
						transform({ method: { update: () => undefined } } as unknown as IntegrationDraft)
					}),
				connection: {
					active: () => Effect.succeed({ id: 'connection' }),
					resolve: () =>
						Effect.sync(() => {
							credentialResolutions += 1
							return credential
						}),
				},
			},
			catalog: {
				transform: (transform: (draft: CatalogDraft) => void) =>
					Effect.sync(() => {
						catalogTransform = transform
					}),
				reload: () => Effect.void,
			},
			aisdk: {
				hook: (_name: string, hook: (event: AISDKHooks['sdk']) => Effect.Effect<void>) =>
					Effect.sync(() => {
						sdkHook = hook
					}),
			},
			session: {
				hook: (_name: string, hook: (event: SessionHooks['context']) => Effect.Effect<void>) =>
					Effect.sync(() => {
						sessionHook = hook
					}),
			},
			event: { subscribe: () => Stream.never },
		} as unknown as Plugin.Context

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* registerAnthropicSubscriptionAuth(context, undefined, providerPackage)
					const catalog = catalogDraft()
					catalogTransform?.(catalog.draft)
					expect(catalog.anthropicProvider.package).toBe(providerPackage)

					const networkRequests: Array<{
						url: string
						headers: Headers
						body: Record<string, unknown>
					}> = []
					vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
						networkRequests.push({
							url: input instanceof Request ? input.url : input.toString(),
							headers: new Headers(init?.headers),
							body: JSON.parse(String(init?.body)) as Record<string, unknown>,
						})
						return new Response(responseSse, {
							status: 200,
							headers: { 'content-type': 'text/event-stream' },
						})
					})

					const event: AISDKHooks['sdk'] = {
						model: {} as AISDKHooks['sdk']['model'],
						package: providerPackage,
						options: { apiKey: credential.access },
					}
					if (sdkHook === undefined) throw new Error('SDK hook was not registered')
					yield* sdkHook(event)
					expect(event.options.apiKey).toBeUndefined()
					expect(event.sdk).toBeDefined()

					const sdk = event.sdk as ReturnType<typeof createAnthropic>
					const language = sdk.languageModel('claude-test')
					const malformedInputSchema = {
						properties: { command: { type: 'string' } },
						required: ['command'],
						additionalProperties: false,
					}
					if (sessionHook === undefined) throw new Error('Session hook was not registered')
					const sessionEvent = {
						model: { providerID: 'anthropic' },
						tools: {
							bash: { description: 'Run a command', input: malformedInputSchema },
						},
					} as unknown as SessionHooks['context']
					yield* sessionHook(sessionEvent)
					const normalizedInputSchema = sessionEvent.tools.bash?.input
					expect(normalizedInputSchema).toEqual(expect.objectContaining({ type: 'object' }))
					const result = yield* Effect.promise(() =>
						Promise.resolve(
							language.doStream({
								prompt: [
									{
										role: 'system',
										content: 'You are OpenCode, the best coding agent.\n\nKeep this instruction.',
									},
									{
										role: 'user',
										content: [{ type: 'text', text: 'hello world test message' }],
									},
									{
										role: 'assistant',
										content: [
											{
												type: 'tool-call',
												toolCallId: 'prior_call',
												toolName: 'bash',
												input: { command: 'pwd' },
											},
										],
									},
								],
								maxOutputTokens: 128,
								tools: [
									{
										type: 'function',
										name: 'bash',
										description: 'Run a command',
										inputSchema: normalizedInputSchema,
									},
								],
							}),
						),
					)

					const parts: Array<unknown> = []
					yield* Effect.promise(async () => {
						const reader = result.stream.getReader()
						for (;;) {
							const next = await reader.read()
							if (next.done) return
							parts.push(next.value)
						}
					})

					expect(networkRequests).toHaveLength(1)
					const request = networkRequests[0]
					expect(request?.url).toBe('https://api.anthropic.com/v1/messages?beta=true')
					expect(request?.headers.get('authorization')).toBe('Bearer oauth-access')
					expect(request?.headers.get('x-api-key')).toBeNull()
					expect(request?.headers.get('anthropic-beta')).toContain('oauth-2025-04-20')
					expect(request?.headers.get('anthropic-beta')).toContain(
						'interleaved-thinking-2025-05-14',
					)

					const tools = request?.body.tools as Array<{
						name: string
						input_schema: Record<string, unknown>
					}>
					expect(tools[0]?.name).toBe('mcp_Bash')
					expect(tools[0]?.input_schema).toEqual(
						expect.objectContaining({
							type: 'object',
							properties: { command: { type: 'string' } },
						}),
					)
					const messages = request?.body.messages as Array<{
						content: Array<Record<string, unknown>>
					}>
					expect(messages[1]?.content[0]).toEqual(
						expect.objectContaining({ type: 'tool_use', name: 'mcp_Bash' }),
					)

					const system = request?.body.system as Array<{ text: string }>
					expect(system[0]?.text).toMatch(/^x-anthropic-billing-header:/u)
					expect(system[1]?.text).toBe(
						"You are a Claude agent, built on Anthropic's Claude Agent SDK.",
					)
					expect(system.map((block) => block.text).join('\n')).toContain('Keep this instruction.')
					expect(system.map((block) => block.text).join('\n')).not.toContain('You are OpenCode')
					expect(parts).toContainEqual(
						expect.objectContaining({ type: 'tool-input-start', toolName: 'bash' }),
					)
					expect(credentialResolutions).toBeGreaterThanOrEqual(3)
				}),
			),
		)
	})

	test('exports the synchronous factory required by OpenCode dynamic provider loading', () => {
		const sdk = createLimitlessAnthropicBootstrap({ apiKey: 'bootstrap-only' })
		expect(sdk.languageModel('claude-test')).toBeDefined()
	})

	test('leaves the native API-key Anthropic SDK package untouched', async () => {
		let sdkHook: ((event: AISDKHooks['sdk']) => Effect.Effect<void>) | undefined
		const context = {
			integration: {
				transform: () => Effect.void,
				connection: { active: () => Effect.void },
			},
			catalog: { transform: () => Effect.void, reload: () => Effect.void },
			aisdk: {
				hook: (_name: string, hook: (event: AISDKHooks['sdk']) => Effect.Effect<void>) =>
					Effect.sync(() => {
						sdkHook = hook
					}),
			},
			session: { hook: () => Effect.void },
			event: { subscribe: () => Stream.never },
		} as unknown as Plugin.Context

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* registerAnthropicSubscriptionAuth(context)
					const options = { apiKey: 'sk-ant-api-key' }
					const event: AISDKHooks['sdk'] = {
						model: {} as AISDKHooks['sdk']['model'],
						package: '@ai-sdk/anthropic',
						options,
					}
					if (sdkHook === undefined) throw new Error('SDK hook was not registered')
					yield* sdkHook(event)
					expect(event.options).toBe(options)
					expect(event.options).toEqual({ apiKey: 'sk-ant-api-key' })
					expect(event.sdk).toBeUndefined()
				}),
			),
		)
	})
})
