import { createAnthropic } from '@ai-sdk/anthropic'
import type { Plugin } from '@opencode-ai/plugin/v2/effect'
import type { AISDKHooks } from '@opencode-ai/plugin/v2/effect/aisdk'
import type { CatalogDraft } from '@opencode-ai/plugin/v2/effect/catalog'
import type { IntegrationDraft } from '@opencode-ai/plugin/v2/effect/integration'
import type { SessionHooks } from '@opencode-ai/plugin/v2/effect/session'
import { Cause, Effect, Semaphore, Stream } from 'effect'
import { DEFAULT_ANTHROPIC_SUBSCRIPTION_AUTH_CONFIG } from './config'
import { ANTHROPIC_INTEGRATION_ID, ANTHROPIC_OAUTH_METHOD_ID, anthropicOAuthMethod } from './oauth'
import {
	type AnthropicV1AuthLoader,
	anthropicV1ProviderFacade,
	loadAnthropicV1AuthLoader,
	runAnthropicV1Auth,
} from './provider-boundary'

export const ANTHROPIC_OAUTH_PROVIDER_PACKAGE = 'aisdk:@limitless/anthropic-subscription'

type AnthropicOAuthCredential = {
	readonly type: 'oauth'
	readonly methodID: string
	readonly refresh: string
	readonly access: string
	readonly expires: number
}

type AnthropicCredentialState =
	| { readonly kind: 'native' }
	| { readonly kind: 'subscription'; readonly credential: AnthropicOAuthCredential }
	| { readonly kind: 'unsafe' }

type ResolveAnthropicCredential = () => Effect.Effect<unknown>

export function registerAnthropicOAuthMethod(
	draft: IntegrationDraft,
	config = DEFAULT_ANTHROPIC_SUBSCRIPTION_AUTH_CONFIG,
	registration = anthropicOAuthMethod(),
): void {
	if (!config.enabled) return
	draft.method.update(registration)
}

export function transformAnthropicOAuthCatalog(
	draft: CatalogDraft,
	subscriptionConnected: boolean,
	blocked = false,
	providerPackage = ANTHROPIC_OAUTH_PROVIDER_PACKAGE,
): void {
	const anthropic = draft.provider.get(ANTHROPIC_INTEGRATION_ID)
	if (anthropic === undefined) return
	if (blocked) {
		draft.provider.update(ANTHROPIC_INTEGRATION_ID, (provider) => {
			provider.disabled = true
		})
		return
	}
	if (!subscriptionConnected) return
	draft.provider.update(ANTHROPIC_INTEGRATION_ID, (provider) => {
		provider.package = providerPackage
	})
	for (const model of anthropic.models.values()) {
		draft.model.update(ANTHROPIC_INTEGRATION_ID, model.id, (updated) => {
			updated.cost = []
			if (updated.package !== undefined) updated.package = providerPackage
		})
	}
}

export function isLimitlessAnthropicOAuthCredential(
	credential: unknown,
): credential is AnthropicOAuthCredential {
	return (
		typeof credential === 'object' &&
		credential !== null &&
		'type' in credential &&
		credential.type === 'oauth' &&
		'methodID' in credential &&
		credential.methodID === ANTHROPIC_OAUTH_METHOD_ID &&
		'refresh' in credential &&
		typeof credential.refresh === 'string' &&
		credential.refresh.length > 0 &&
		'access' in credential &&
		typeof credential.access === 'string' &&
		credential.access.length > 0 &&
		'expires' in credential &&
		typeof credential.expires === 'number' &&
		Number.isSafeInteger(credential.expires) &&
		credential.expires > Date.now() + 60_000
	)
}

function classifyAnthropicCredential(credential: unknown): AnthropicCredentialState {
	if (credential === undefined) return { kind: 'native' }
	if (
		typeof credential === 'object' &&
		credential !== null &&
		'type' in credential &&
		credential.type === 'key' &&
		'key' in credential &&
		typeof credential.key === 'string' &&
		credential.key.length > 0
	) {
		return { kind: 'native' }
	}
	if (isLimitlessAnthropicOAuthCredential(credential)) {
		return { kind: 'subscription', credential }
	}
	return { kind: 'unsafe' }
}

function resolveSubscriptionCredential(resolveCredential: ResolveAnthropicCredential) {
	return resolveCredential().pipe(
		Effect.flatMap((credential) => {
			const state = classifyAnthropicCredential(credential)
			return state.kind === 'subscription'
				? Effect.succeed(state.credential)
				: Effect.die(new Error('Anthropic subscription credential is unavailable or unsafe.'))
		}),
	)
}

function normalizeAnthropicToolInputSchemas(event: SessionHooks['context']): void {
	if (event.model.providerID !== ANTHROPIC_INTEGRATION_ID) return
	for (const tool of Object.values(event.tools)) {
		const input = tool.input
		if (typeof input !== 'object' || input === null || Array.isArray(input) || 'type' in input)
			continue
		tool.input = { ...input, type: 'object' }
	}
}

function configureAnthropicSubscriptionSdk(
	event: AISDKHooks['sdk'],
	loader: AnthropicV1AuthLoader,
	resolveCredential: ResolveAnthropicCredential,
	providerPackage: string,
) {
	if (
		event.package !== providerPackage &&
		event.package !== providerPackage.slice('aisdk:'.length)
	) {
		return Effect.void
	}

	return Effect.gen(function* () {
		const credential = yield* resolveSubscriptionCredential(resolveCredential)
		const loaded = yield* Effect.tryPromise(() =>
			loader(
				() =>
					runAnthropicV1Auth(resolveSubscriptionCredential(resolveCredential)).then((current) => ({
						type: current.type,
						access: current.access,
						refresh: current.refresh,
						expires: current.expires,
					})),
				anthropicV1ProviderFacade(),
			),
		)
		if (typeof loaded.fetch !== 'function') {
			return yield* Effect.die(
				new Error('@ex-machina/opencode-anthropic-auth did not return its OAuth fetch.'),
			)
		}

		delete event.options.apiKey
		// AI SDK requires one auth setting before it invokes custom fetch. The dependency's fetch
		// re-resolves the V2-owned credential and overwrites this header on every request.
		event.options.authToken = credential.access
		event.options.fetch = loaded.fetch
		event.sdk = createAnthropic(event.options)
		yield* Effect.logInfo('[limitless] initialized the Anthropic subscription AI SDK adapter')
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.logError(
				'[limitless] failed to initialize the Anthropic subscription AI SDK adapter',
				cause,
			).pipe(Effect.andThen(Effect.failCause(cause))),
		),
		Effect.orDie,
	)
}

export const registerAnthropicSubscriptionAuth = Effect.fn('registerAnthropicSubscriptionAuth')(
	function* (
		ctx: Plugin.Context,
		config = DEFAULT_ANTHROPIC_SUBSCRIPTION_AUTH_CONFIG,
		providerPackage = ANTHROPIC_OAUTH_PROVIDER_PACKAGE,
	) {
		if (!config.enabled) {
			const connection = yield* ctx.integration.connection.active(ANTHROPIC_INTEGRATION_ID)
			if (connection === undefined) return
			let lingeringSubscription = false
			const blocked = yield* ctx.integration.connection.resolve(connection).pipe(
				Effect.map((credential) => {
					lingeringSubscription = isLimitlessAnthropicOAuthCredential(credential)
					return classifyAnthropicCredential(credential).kind !== 'native'
				}),
				Effect.catchCause((cause) =>
					Effect.logError(
						'[limitless] could not inspect the active Anthropic credential while subscription auth is disabled; Anthropic models will be blocked',
						cause,
					).pipe(Effect.as(true)),
				),
			)
			if (!blocked) return
			if (lingeringSubscription) {
				yield* Effect.logWarning(
					'[limitless] Anthropic subscription auth is disabled, but its Claude Pro/Max OAuth connection is still active. Disconnect it and restart OpenCode; Anthropic models are blocked to prevent sending the OAuth token as x-api-key.',
				)
			}
			yield* ctx.catalog.transform((draft) => {
				transformAnthropicOAuthCatalog(draft, false, true, providerPackage)
			})
			yield* ctx.catalog.reload()
			return
		}

		let subscriptionConnected = false
		let blocked = true
		const loader = yield* Effect.tryPromise(loadAnthropicV1AuthLoader).pipe(Effect.orDie)
		const resolveCredential: ResolveAnthropicCredential = () =>
			Effect.gen(function* () {
				const connection = yield* ctx.integration.connection.active(ANTHROPIC_INTEGRATION_ID)
				return connection ? yield* ctx.integration.connection.resolve(connection) : undefined
			}).pipe(Effect.orDie)

		yield* ctx.integration.transform((draft) => {
			registerAnthropicOAuthMethod(draft, config, anthropicOAuthMethod(fetch, Date.now))
		})
		yield* ctx.catalog.transform((draft) => {
			transformAnthropicOAuthCatalog(draft, subscriptionConnected, blocked, providerPackage)
		})
		yield* ctx.aisdk.hook(
			'sdk',
			Effect.fn('configureAnthropicSubscriptionSdk')((event) =>
				configureAnthropicSubscriptionSdk(event, loader, resolveCredential, providerPackage),
			),
		)
		yield* ctx.session.hook(
			'context',
			Effect.fn('normalizeAnthropicSubscriptionToolSchemas')((event) =>
				Effect.sync(() => {
					if (!subscriptionConnected) return
					normalizeAnthropicToolInputSchemas(event)
				}),
			),
		)

		const loading = yield* Semaphore.make(1)
		const load = Effect.fn('loadAnthropicSubscriptionConnection')(function* () {
			const state = classifyAnthropicCredential(yield* resolveCredential())
			subscriptionConnected = state.kind === 'subscription'
			blocked = state.kind === 'unsafe'
			if (blocked) {
				yield* Effect.logError(
					'[limitless] the active Anthropic credential is not a valid Limitless Claude Pro/Max credential; Anthropic models are blocked',
				)
			}
		})
		const reload = Effect.fn('reloadAnthropicSubscriptionConnection')(function* (trigger: string) {
			yield* loading.withPermit(
				load().pipe(
					Effect.catchCause((cause) =>
						Effect.sync(() => {
							subscriptionConnected = false
							blocked = true
						}).pipe(
							Effect.andThen(
								Effect.logError(
									`[limitless] failed to resolve the Anthropic connection after ${trigger}; Anthropic models remain blocked until the next connection event`,
									cause,
								),
							),
						),
					),
					Effect.andThen(ctx.catalog.reload()),
				),
			)
		})
		const blockForStoppedEventStream = Effect.fn('blockAnthropicForStoppedEventStream')(function* (
			cause?: Cause.Cause<unknown>,
		) {
			yield* loading.withPermit(
				Effect.sync(() => {
					subscriptionConnected = false
					blocked = true
				}).pipe(
					Effect.andThen(
						cause === undefined
							? Effect.logError(
									'[limitless] Anthropic connection event stream completed; Anthropic models are blocked',
								)
							: Effect.logError(
									'[limitless] Anthropic connection event stream stopped; Anthropic models are blocked',
									cause,
								),
					),
					Effect.andThen(ctx.catalog.reload()),
				),
			)
		})

		yield* ctx.event.subscribe().pipe(
			Stream.filter(
				(event) =>
					event.type === 'integration.connection.updated' &&
					event.data.integrationID === ANTHROPIC_INTEGRATION_ID,
			),
			Stream.runForEach(() => reload('integration.connection.updated')),
			Effect.andThen(blockForStoppedEventStream()),
			Effect.catchCause((cause) =>
				cause.reasons.every(Cause.isInterruptReason)
					? Effect.void
					: blockForStoppedEventStream(cause),
			),
			Effect.forkScoped({ startImmediately: true }),
		)
		yield* reload('plugin startup')
	},
)
