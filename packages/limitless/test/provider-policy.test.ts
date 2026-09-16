import type { ProviderEditor, ProviderRecord } from '@opencode/plugin/effect/provider'
import { Provider } from '@opencode/schema/provider'
import { Effect, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import {
	applyProviderPolicy,
	DEFAULT_DISABLED_PROVIDERS,
	normalizeProviderPolicyConfig,
	ProviderPolicyConfigError,
} from '../plugin/provider-policy'

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
	test('disables both Vertex providers by default without disabling Google', async () => {
		const config = await Effect.runPromise(normalizeProviderPolicyConfig({}))
		const state = providers('google', 'google-vertex', 'google-vertex-anthropic')

		applyProviderPolicy(state.draft, config)

		expect(config.disabled).toEqual(DEFAULT_DISABLED_PROVIDERS)
		expect(state.records.get('google')?.provider.activation).toBe('auto')
		expect(state.records.has('google-vertex')).toBe(false)
		expect(state.records.has('google-vertex-anthropic')).toBe(false)
	})

	test('supports an explicit provider list and deduplicates it', async () => {
		const config = await Effect.runPromise(
			normalizeProviderPolicyConfig({
				providers: { disabled: ['amazon-bedrock', 'amazon-bedrock'] },
			}),
		)
		const state = providers('google-vertex', 'amazon-bedrock')

		applyProviderPolicy(state.draft, config)

		expect(config.disabled).toEqual(['amazon-bedrock'])
		expect([...state.records.keys()]).toEqual(['google-vertex'])
	})

	test('preserves every provider when the disabled list is empty', async () => {
		const config = await Effect.runPromise(
			normalizeProviderPolicyConfig({ providers: { disabled: [] } }),
		)
		const state = providers('google', 'google-vertex', 'google-vertex-anthropic')

		applyProviderPolicy(state.draft, config)

		expect([...state.records.keys()]).toEqual([
			'google',
			'google-vertex',
			'google-vertex-anthropic',
		])
	})

	test('can replay the policy when disabled providers are already absent', async () => {
		const config = await Effect.runPromise(normalizeProviderPolicyConfig({}))
		const state = providers('google', 'google-vertex')

		applyProviderPolicy(state.draft, config)
		applyProviderPolicy(state.draft, config)

		expect([...state.records.keys()]).toEqual(['google'])
	})

	test('rejects malformed provider IDs', async () => {
		const error = await Effect.runPromise(
			normalizeProviderPolicyConfig({ providers: { disabled: ['  '] } }).pipe(Effect.flip),
		)
		expect(error).toBeInstanceOf(ProviderPolicyConfigError)
	})
})
