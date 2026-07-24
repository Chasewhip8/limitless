import { Plugin } from '@opencode-ai/plugin/v2/effect'
import type { CatalogDraft } from '@opencode-ai/plugin/v2/effect/catalog'
import { Effect, Semaphore, Stream } from 'effect'
import {
	type AnthropicCredentialMode,
	applyAnthropicCatalog,
	blockedCredentialMessage,
	routingConflictError,
} from './catalog'
import { PLUGIN_ID } from './constants'
import { applyAnthropicIntegration } from './integration'
import { isMarkedMaxCredential } from './oauth'

export function defineAnthropicAuthPlugin(moduleURL: string) {
	return Plugin.define({
		id: PLUGIN_ID,
		effect: Effect.fn('limitless.anthropic-auth.plugin')(function* (ctx) {
			yield* ctx.integration.transform(applyAnthropicIntegration)

			const active = { mode: yield* resolveCredentialMode(ctx) }
			const applyCatalog = (catalog: CatalogDraft) => {
				applyAnthropicCatalog(catalog, active.mode, moduleURL)
			}
			let catalogRegistration = yield* ctx.catalog.transform(applyCatalog)
			yield* ctx.session.hook('context', (event) => {
				if (event.model.providerID !== 'anthropic') return Effect.void
				if (active.mode === 'blocked') return Effect.die(new Error(blockedCredentialMessage))
				if (active.mode !== 'max') return Effect.void
				return ctx.catalog.model.get(event.model.providerID, event.model.id).pipe(
					Effect.flatMap((selected) => {
						const conflict = routingConflictError(
							event.model.providerID,
							event.model.id,
							selected?.package,
							moduleURL,
						)
						return conflict ? Effect.die(conflict) : Effect.void
					}),
				)
			})

			const stateLock = Semaphore.makeUnsafe(1)
			const synchronize = () =>
				stateLock.withPermit(
					resolveCredentialMode(ctx).pipe(
						Effect.tap((next) => Effect.sync(() => (active.mode = next))),
						Effect.andThen(ctx.catalog.reload()),
					),
				)
			const moveCatalogTransformLast = () =>
				stateLock.withPermit(
					Effect.gen(function* () {
						// Register the replacement first so the catalog never exposes an intermediate
						// state without the Max routing guard.
						const next = yield* ctx.catalog.transform(applyCatalog)
						yield* catalogRegistration.dispose
						catalogRegistration = next
					}),
				)
			yield* ctx.event.subscribe().pipe(
				Stream.filter(
					(event) =>
						event.type === 'integration.connection.updated' &&
						event.data.integrationID === 'anthropic',
				),
				Stream.runForEach(synchronize),
				Effect.catchCause(() =>
					Effect.logError('[limitless.anthropic-auth] Anthropic connection event stream stopped.'),
				),
				Effect.forkScoped({ startImmediately: true }),
			)
			yield* ctx.event.subscribe().pipe(
				Stream.filter((event) => event.type === 'plugin.updated'),
				Stream.runForEach(moveCatalogTransformLast),
				Effect.catchCause(() =>
					Effect.logError('[limitless.anthropic-auth] Plugin-order event stream stopped.'),
				),
				Effect.forkScoped({ startImmediately: true }),
			)
			// Re-read after subscribing so a connection update during plugin startup cannot be missed.
			yield* synchronize()
		}),
	})
}

export default defineAnthropicAuthPlugin(new URL('../index.ts', import.meta.url).href)

function resolveCredentialMode(ctx: Plugin.Context): Effect.Effect<AnthropicCredentialMode> {
	return Effect.gen(function* () {
		const connection = yield* ctx.integration.connection.active('anthropic')
		if (!connection) return 'stock' as const
		const credential = yield* ctx.integration.connection.resolve(connection)
		if (credential?.type !== 'oauth') return 'stock' as const
		return isMarkedMaxCredential(credential) ? ('max' as const) : ('blocked' as const)
	}).pipe(
		Effect.catchCause(() =>
			Effect.logError(
				'[limitless.anthropic-auth] Unable to resolve the active Anthropic credential; blocking Anthropic routes.',
			).pipe(Effect.as('blocked' as const)),
		),
	)
}
