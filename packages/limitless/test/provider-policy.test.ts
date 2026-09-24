import type { ProviderEditor, ProviderRecord } from '@opencode/plugin/effect/provider'
import { Provider } from '@opencode/schema/provider'
import { Effect, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { applyProviderPolicy, normalizeProviderPolicyConfig } from '../plugin/provider-policy'

function providers(...providerIDs: ReadonlyArray<string>) {
	const records = new Map<string, ProviderRecord>(
		providerIDs.map((id) => [
			id,
			{
				provider: Schema.decodeUnknownSync(Provider.Info)({
					id,
					name: id,
					activation: 'auto',
					package: `aisdk:${id}`,
				}),
				models: new Map(),
			},
		]),
	)
	const draft: ProviderEditor = {
		list: () => [...records.values()],
		get: (id) => records.get(id),
		add: () => {},
		update: (id, update) => {
			const record = records.get(id)
			if (record) update(record.provider)
		},
		remove: (id) => records.delete(id),
		models: {
			set: () => {},
			update: () => {},
			remove: () => {},
		},
	}
	return { draft, records }
}

describe('provider policy', () => {
	test('removes ambient Vertex providers by default and keeps Google', async () => {
		const config = await Effect.runPromise(normalizeProviderPolicyConfig({}))
		const state = providers('google', 'google-vertex', 'google-vertex-anthropic')

		applyProviderPolicy(state.draft, config)
		applyProviderPolicy(state.draft, config)

		expect([...state.records.keys()]).toEqual(['google'])
	})
})
