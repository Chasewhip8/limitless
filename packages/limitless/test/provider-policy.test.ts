import type { CatalogDraft, CatalogProviderRecord } from '@opencode-ai/plugin/v2/effect/catalog'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import {
	applyProviderPolicy,
	DEFAULT_DISABLED_PROVIDERS,
	normalizeProviderPolicyConfig,
	ProviderPolicyConfigError,
} from '../plugin/provider-policy'

function catalog(...providerIDs: ReadonlyArray<string>) {
	const records = new Map<string, CatalogProviderRecord>(
		providerIDs.map((id) => [
			id,
			{
				provider: { id, name: id, package: `aisdk:${id}` },
				models: new Map(),
			},
		]),
	)
	const draft: CatalogDraft = {
		provider: {
			list: () => [...records.values()],
			get: (id) => records.get(id),
			update: (id, update) => {
				const record = records.get(id)
				if (record) update(record.provider)
			},
			remove: (id) => records.delete(id),
		},
		model: {
			get: () => undefined,
			update: () => {},
			remove: () => {},
			default: { get: () => undefined, set: () => {} },
		},
	}
	return { draft, records }
}

describe('provider policy', () => {
	test('disables both Vertex catalogs by default without disabling Google', async () => {
		const config = await Effect.runPromise(normalizeProviderPolicyConfig({}))
		const state = catalog('google', 'google-vertex', 'google-vertex-anthropic')

		applyProviderPolicy(state.draft, config)

		expect(config.disabled).toEqual(DEFAULT_DISABLED_PROVIDERS)
		expect(state.records.get('google')?.provider.disabled).toBeUndefined()
		expect(state.records.get('google-vertex')?.provider.disabled).toBe(true)
		expect(state.records.get('google-vertex-anthropic')?.provider.disabled).toBe(true)
	})

	test('supports an explicit provider list and deduplicates it', async () => {
		const config = await Effect.runPromise(
			normalizeProviderPolicyConfig({
				providers: { disabled: ['amazon-bedrock', 'amazon-bedrock'] },
			}),
		)
		expect(config.disabled).toEqual(['amazon-bedrock'])
	})

	test('rejects malformed provider IDs', async () => {
		const error = await Effect.runPromise(
			normalizeProviderPolicyConfig({ providers: { disabled: ['  '] } }).pipe(Effect.flip),
		)
		expect(error).toBeInstanceOf(ProviderPolicyConfigError)
	})
})
