import type { CatalogDraft, CatalogProviderRecord } from '@opencode-ai/plugin/v2/effect/catalog'
import { describe, expect, it } from 'vitest'
import { applyAnthropicCatalog, packageConflictMessage, routingConflictError } from '../src/catalog'

type CatalogModel =
	CatalogProviderRecord['models'] extends ReadonlyMap<string, infer Model> ? Model : never

function makeModel(
	id: string,
	input: Partial<Pick<CatalogModel, 'package' | 'enabled' | 'name' | 'cost'>> = {},
): CatalogModel {
	return {
		id,
		modelID: id,
		providerID: 'anthropic',
		name: input.name ?? id,
		capabilities: { tools: true, input: ['text'], output: ['text'] },
		variants: [],
		time: { released: 0 },
		cost: input.cost ?? [
			{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
			{
				tier: { type: 'context', size: 200_000 },
				input: 6,
				output: 22.5,
				cache: { read: 0.6, write: 7.5 },
			},
		],
		status: 'active',
		enabled: input.enabled ?? true,
		limit: { context: 200_000, output: 8192 },
		...(input.package === undefined ? {} : { package: input.package }),
	}
}

function catalog(
	providerPackage: string,
	entries: ReadonlyArray<readonly [string, CatalogModel]>,
): { readonly draft: CatalogDraft; readonly record: CatalogProviderRecord } {
	const record: CatalogProviderRecord = {
		provider: {
			id: 'anthropic',
			integrationID: 'anthropic',
			name: 'Anthropic',
			package: providerPackage,
		},
		models: new Map(entries),
	}
	const draft: CatalogDraft = {
		provider: {
			list: () => [record],
			get: (providerID) => (providerID === 'anthropic' ? record : undefined),
			update: (providerID, update) => {
				if (providerID === 'anthropic') update(record.provider)
			},
			remove: () => {},
		},
		model: {
			get: (providerID, modelID) =>
				providerID === 'anthropic' ? record.models.get(modelID) : undefined,
			update: (providerID, modelID, update) => {
				const found = providerID === 'anthropic' ? record.models.get(modelID) : undefined
				if (found) update(found)
			},
			remove: () => {},
			default: {
				get: () => undefined,
				set: () => {},
			},
		},
	}
	return { draft, record }
}

describe('credential-aware catalog transform', () => {
	it('reroutes only stock effective Anthropic packages and preserves custom choices', () => {
		const moduleURL = 'file:///limitless/anthropic-auth/index.ts'
		const stock = makeModel('stock')
		const custom = makeModel('custom', { package: 'file:///custom/provider.ts' })
		const state = catalog('aisdk:@ai-sdk/anthropic', [
			['stock', stock],
			['custom', custom],
		])
		applyAnthropicCatalog(state.draft, 'stock', moduleURL)

		expect(state.record.provider.package).toBe(moduleURL)
		expect(stock.package).toBeUndefined()
		expect(custom.package).toBe('file:///custom/provider.ts')
		expect(custom.enabled).toBe(true)
		expect(stock.cost[0]?.input).toBe(3)
	})

	it('reroutes an explicit stock model without replacing a custom provider package', () => {
		const moduleURL = 'file:///limitless/anthropic-auth/index.ts'
		const stock = makeModel('stock', { package: '@opencode-ai/ai/providers/anthropic' })
		const state = catalog('file:///custom/provider.ts', [['stock', stock]])
		applyAnthropicCatalog(state.draft, 'stock', moduleURL)
		expect(state.record.provider.package).toBe('file:///custom/provider.ts')
		expect(stock.package).toBe(moduleURL)
	})

	it('zeros every price tier only while marked Max is active', () => {
		const maxModel = makeModel('max')
		const active = catalog('aisdk:@ai-sdk/anthropic', [['max', maxModel]])
		applyAnthropicCatalog(active.draft, 'max', 'file:///auth.ts')
		expect(maxModel.cost).toEqual([
			{ input: 0, output: 0, cache: { read: 0, write: 0 } },
			{
				tier: { type: 'context', size: 200_000 },
				input: 0,
				output: 0,
				cache: { read: 0, write: 0 },
			},
		])

		const paidModel = makeModel('paid')
		const inactive = catalog('aisdk:@ai-sdk/anthropic', [['paid', paidModel]])
		applyAnthropicCatalog(inactive.draft, 'stock', 'file:///auth.ts')
		expect(paidModel.cost[0]).toMatchObject({ input: 3, output: 15 })
	})

	it('fails closed on custom package routing during Max without overwriting the package', () => {
		const custom = makeModel('custom', { package: 'file:///custom/provider.ts' })
		const state = catalog('aisdk:@ai-sdk/anthropic', [['custom', custom]])
		applyAnthropicCatalog(state.draft, 'max', 'file:///auth.ts')

		expect(custom.package).toBe('file:///custom/provider.ts')
		expect(custom.enabled).toBe(false)
		expect(custom.name).toContain(packageConflictMessage)
		expect(
			routingConflictError('anthropic', custom.id, custom.package, 'file:///auth.ts')?.message,
		).toContain('Refusing Claude Max OAuth dispatch')
		expect(
			routingConflictError('anthropic', custom.id, 'file:///auth.ts', 'file:///auth.ts'),
		).toBeUndefined()
	})

	it('blocks every Anthropic model without changing prices for an unmarked OAuth credential', () => {
		const stock = makeModel('stock')
		const custom = makeModel('custom', { package: 'file:///custom/provider.ts' })
		const state = catalog('aisdk:@ai-sdk/anthropic', [
			['stock', stock],
			['custom', custom],
		])

		applyAnthropicCatalog(state.draft, 'blocked', 'file:///auth.ts')

		expect(stock.enabled).toBe(false)
		expect(custom.enabled).toBe(false)
		expect(stock.cost[0]).toMatchObject({ input: 3, output: 15 })
		expect(custom.cost[0]).toMatchObject({ input: 3, output: 15 })
	})
})
