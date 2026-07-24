import type { CatalogDraft } from '@opencode-ai/plugin/v2/effect/catalog'
import { MAX_METADATA_KEY, STOCK_ANTHROPIC_PACKAGES } from './constants'

const CONFLICT_SUFFIX =
	' (disabled: Claude Max OAuth requires the stock Anthropic provider package)'
const BLOCKED_SUFFIX =
	' (disabled: reconnect Anthropic because the active OAuth credential is not marked for Claude Max)'

export type AnthropicCredentialMode = 'stock' | 'max' | 'blocked'

export function isStockAnthropicPackage(
	packageName: string | undefined,
	moduleURL: string,
): boolean {
	return (
		packageName === moduleURL ||
		(packageName !== undefined && STOCK_ANTHROPIC_PACKAGES.has(packageName))
	)
}

export function applyAnthropicCatalog(
	catalog: CatalogDraft,
	mode: AnthropicCredentialMode,
	moduleURL: string = new URL('../index.ts', import.meta.url).href,
): void {
	const record = catalog.provider.get('anthropic')
	if (!record) return
	catalog.provider.update('anthropic', (provider) => {
		if (provider.settings) delete provider.settings[MAX_METADATA_KEY]
	})
	const providerPackage = record.provider.package
	if (isStockAnthropicPackage(providerPackage, moduleURL) && providerPackage !== moduleURL) {
		catalog.provider.update('anthropic', (provider) => {
			provider.package = moduleURL
		})
	}

	for (const [modelID, model] of record.models) {
		catalog.model.update('anthropic', modelID, (draft) => {
			if (draft.settings) delete draft.settings[MAX_METADATA_KEY]
		})
		const effectivePackage = model.package ?? providerPackage
		if (isStockAnthropicPackage(effectivePackage, moduleURL)) {
			if (model.package !== undefined && model.package !== moduleURL) {
				catalog.model.update('anthropic', modelID, (draft) => {
					draft.package = moduleURL
				})
			}
		} else if (mode === 'max') {
			catalog.model.update('anthropic', modelID, (draft) => {
				draft.enabled = false
				if (!draft.name.endsWith(CONFLICT_SUFFIX)) draft.name += CONFLICT_SUFFIX
			})
		}

		if (mode === 'blocked') {
			catalog.model.update('anthropic', modelID, (draft) => {
				draft.enabled = false
				if (!draft.name.endsWith(BLOCKED_SUFFIX)) draft.name += BLOCKED_SUFFIX
			})
		}

		if (mode === 'max') {
			catalog.model.update('anthropic', modelID, (draft) => {
				draft.cost = draft.cost.map((cost) => ({
					...cost,
					input: 0,
					output: 0,
					cache: { read: 0, write: 0 },
				}))
			})
		}
	}
}

export const packageConflictMessage = CONFLICT_SUFFIX.slice(2, -1)
export const blockedCredentialMessage = BLOCKED_SUFFIX.slice(2, -1)

export function routingConflictError(
	providerID: string,
	modelID: string,
	packageName: string | undefined,
	moduleURL: string,
): Error | undefined {
	if (providerID !== 'anthropic' || packageName === moduleURL) return undefined
	return new Error(
		`Refusing Claude Max OAuth dispatch for anthropic/${modelID}: the final provider package is ${packageName || 'unset'}, not ${moduleURL}. Restore the stock Anthropic package or switch to an API-key connection.`,
	)
}
