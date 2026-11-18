import type { ProviderEditor } from '@opencode/plugin/effect/provider'
import { Model } from '@opencode/schema/model'
import { Money } from '@opencode/schema/money'
import { Provider } from '@opencode/schema/provider'

// OpenCode 2.3.2 allows GPT-6.2 for ChatGPT token sharing, but its bundled models.dev snapshot
// and older cached catalogs can still lack the definitions. OpenCode's provider plugins route,
// price, and cap them. Remove this backfill once the pinned release can supply both models
// through ChatGPT token sharing without a catalog refresh.
const openai = Provider.ID.make('openai')

type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

// Transcribed from models.dev (https://models.opencode.ai/experimental/v2.0/api.json) on 2026-11-17.
// Prices above 272k context tokens form OpenCode's context cost tier.
const gpt62 = [
	{
		id: 'gpt-6.2-astra',
		name: 'GPT-6.2 Astra',
		family: 'gpt-astra',
		price: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 },
		longContextPrice: { input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 },
	},
	{
		id: 'gpt-6.2-sol',
		name: 'GPT-6.2 Sol',
		family: 'gpt-sol',
		price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		longContextPrice: { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
	},
]

const efforts = ['low', 'medium', 'high', 'xhigh', 'max']
const longContext = 272_000

function cost(price: Price) {
	const usd = Money.USDPerMillionTokens.make
	return {
		input: usd(price.input),
		output: usd(price.output),
		cache: { read: usd(price.cacheRead), write: usd(price.cacheWrite) },
	}
}

// Matches what OpenCode's catalog normalizer builds for an OpenAI Responses model.
function catalogModel(model: (typeof gpt62)[number]): Model.Info {
	return {
		id: Model.ID.make(model.id),
		modelID: Model.ID.make(model.id),
		providerID: openai,
		type: 'chat',
		name: model.name,
		family: Model.Family.make(model.family),
		capabilities: {
			tools: true,
			freeform: ['text', 'lark', 'regex'],
			input: ['text', 'image', 'pdf'],
			output: ['text'],
			temperature: false,
		},
		variants: efforts.map((effort) => ({
			id: Model.VariantID.make(effort),
			settings: {
				reasoningEffort: effort,
				reasoningSummary: 'auto',
				include: ['reasoning.encrypted_content'],
			},
		})),
		time: { released: Date.parse('2026-11-17') },
		cost: [
			cost(model.price),
			{ tier: { type: 'context', size: longContext }, ...cost(model.longContextPrice) },
		],
		status: 'active',
		enabled: true,
		limit: { context: 1_050_000, input: 922_000, output: 128_000 },
	}
}

const backfill = gpt62.map(catalogModel)

/**
 * Adds GPT-6.2 definitions missing from an existing OpenAI provider. Call it from a provider
 * transform, after OpenCode's provider sources and before its model policies.
 */
export function backfillOpenAIModels(providers: Pick<ProviderEditor, 'get' | 'models'>): void {
	const provider = providers.get(openai)
	if (provider === undefined) return
	for (const model of backfill) {
		if (provider.models.has(model.id)) continue
		providers.models.update(openai, model.id, (draft) => {
			Object.assign(draft, structuredClone(model))
		})
	}
}
