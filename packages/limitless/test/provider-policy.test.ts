import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { applyProviderPolicy, normalizeProviderPolicyConfig } from '../plugin/provider-policy'

describe('provider policy', () => {
	test('removes ambient Vertex providers by default and keeps Google', async () => {
		const config = await Effect.runPromise(normalizeProviderPolicyConfig({}))
		const providers = new Set(['google', 'google-vertex', 'google-vertex-anthropic'])
		const editor = { remove: (id: string) => providers.delete(id) }

		applyProviderPolicy(editor, config)
		applyProviderPolicy(editor, config)

		expect([...providers]).toEqual(['google'])
	})
})
