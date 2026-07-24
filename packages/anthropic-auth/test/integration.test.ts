import type {
	IntegrationDraft,
	IntegrationMethodRegistration,
} from '@opencode-ai/plugin/v2/effect/integration'
import { describe, expect, it } from 'vitest'
import { MAX_METHOD_ID, PLUGIN_ID } from '../src/constants'
import { applyAnthropicIntegration } from '../src/integration'
import plugin from '../src/plugin'

type IntegrationMethod = ReturnType<IntegrationDraft['method']['list']>[number]

describe('V2 integration registration', () => {
	it('registers only the Max PKCE method while preserving key and env methods', () => {
		const methods: IntegrationMethod[] = [
			{ type: 'key', label: 'API key' },
			{ type: 'env', names: ['ANTHROPIC_API_KEY'] },
		]
		const registrations: IntegrationMethodRegistration[] = []
		const draft: IntegrationDraft = {
			list: () => [{ id: 'anthropic', name: 'Anthropic' }],
			get: (id) => (id === 'anthropic' ? { id: 'anthropic', name: 'Anthropic' } : undefined),
			update: () => {},
			remove: () => {},
			method: {
				list: () => methods,
				update: (registration) => {
					registrations.push(registration)
					methods.push(registration.method)
				},
				remove: () => {},
			},
		}

		applyAnthropicIntegration(draft)
		expect(methods).toEqual([
			{ type: 'key', label: 'API key' },
			{ type: 'env', names: ['ANTHROPIC_API_KEY'] },
			{ id: MAX_METHOD_ID, type: 'oauth', label: 'Claude Pro/Max' },
		])
		expect(registrations).toHaveLength(1)
		expect(registrations[0]).toHaveProperty('authorize')
		expect(
			methods.some((method) => method.type === 'oauth' && method.label.includes('Create')),
		).toBe(false)
	})

	it('uses a unique V2 plugin ID', () => {
		expect(plugin.id).toBe(PLUGIN_ID)
	})
})
