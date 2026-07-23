import type { Plugin } from '@opencode-ai/plugin/v2/effect'
import type { CatalogDraft } from '@opencode-ai/plugin/v2/effect/catalog'
import type { IntegrationDraft } from '@opencode-ai/plugin/v2/effect/integration'
import { Cause, Effect, Semaphore, Stream } from 'effect'
import { DEFAULT_ANTHROPIC_SUBSCRIPTION_AUTH_CONFIG } from './config'
import { ANTHROPIC_INTEGRATION_ID, ANTHROPIC_OAUTH_METHOD_ID, anthropicOAuthMethod } from './oauth'
import {
	CLAUDE_CODE_USER_AGENT,
	prepareAnthropicOAuthSystem,
	REQUIRED_ANTHROPIC_OAUTH_BETAS,
} from './transform'

export const ANTHROPIC_PROVIDER_PACKAGE = '@opencode-ai/ai/providers/anthropic'
const anthropicAISDKPackage = 'aisdk:@ai-sdk/anthropic'

function mergeAnthropicOAuthBetas(current: string | undefined): string {
	return [
		...new Set([
			...REQUIRED_ANTHROPIC_OAUTH_BETAS,
			...(current ?? '')
				.split(',')
				.map((value) => value.trim())
				.filter(Boolean),
		]),
	].join(',')
}

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
		// OpenCode handles this native package before AI SDK hooks and maps OAuth credentials to Bearer auth.
		if (provider.package === anthropicAISDKPackage) provider.package = ANTHROPIC_PROVIDER_PACKAGE
		provider.headers = {
			...provider.headers,
			accept: 'application/json',
			'anthropic-beta': mergeAnthropicOAuthBetas(provider.headers?.['anthropic-beta']),
			'anthropic-dangerous-direct-browser-access': 'true',
			'user-agent': CLAUDE_CODE_USER_AGENT,
			'x-app': 'cli',
		}
	})
	for (const model of anthropic.models.values()) {
		draft.model.update(ANTHROPIC_INTEGRATION_ID, model.id, (updated) => {
			updated.cost = []
			if (updated.package === anthropicAISDKPackage) updated.package = ANTHROPIC_PROVIDER_PACKAGE
		})
	}
}

export function isLimitlessAnthropicOAuthCredential(credential: unknown): boolean {
	return (
		typeof credential === 'object' &&
		credential !== null &&
		'type' in credential &&
		credential.type === 'oauth' &&
		'methodID' in credential &&
		credential.methodID === ANTHROPIC_OAUTH_METHOD_ID
	)
}

export const registerAnthropicSubscriptionAuth = Effect.fn('registerAnthropicSubscriptionAuth')(
	function* (ctx: Plugin.Context, config = DEFAULT_ANTHROPIC_SUBSCRIPTION_AUTH_CONFIG) {
		if (!config.enabled) {
			const connection = yield* ctx.integration.connection.active(ANTHROPIC_INTEGRATION_ID)
			if (connection === undefined) return
			let lingeringSubscription = false
			const blocked = yield* ctx.integration.connection.resolve(connection).pipe(
				Effect.map((credential) => {
					lingeringSubscription = isLimitlessAnthropicOAuthCredential(credential)
					return lingeringSubscription
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
				transformAnthropicOAuthCatalog(draft, false, true)
			})
			yield* ctx.catalog.reload()
			return
		}

		let subscriptionConnected = false
		let blocked = true

		yield* ctx.integration.transform((draft) => {
			registerAnthropicOAuthMethod(draft, config, anthropicOAuthMethod(fetch, Date.now))
		})
		yield* ctx.catalog.transform((draft) => {
			transformAnthropicOAuthCatalog(draft, subscriptionConnected, blocked)
		})
		yield* ctx.session.hook(
			'context',
			Effect.fn('configureAnthropicSubscriptionContext')((event) =>
				Effect.sync(() => {
					if (!subscriptionConnected || event.model.providerID !== ANTHROPIC_INTEGRATION_ID) return
					event.system = prepareAnthropicOAuthSystem(event.system, event.messages)
				}),
			),
		)

		const loading = yield* Semaphore.make(1)
		const load = Effect.fn('loadAnthropicSubscriptionConnection')(function* () {
			const connection = yield* ctx.integration.connection.active(ANTHROPIC_INTEGRATION_ID)
			const credential = connection
				? yield* ctx.integration.connection.resolve(connection)
				: undefined
			subscriptionConnected = isLimitlessAnthropicOAuthCredential(credential)
			blocked = false
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
