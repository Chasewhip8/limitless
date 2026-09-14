import { expect, test } from 'bun:test'
import plugin from './dist/anthropic-auth.js'

test('bundles the OpenCode 2 Promise plugin', () => {
	expect(plugin.id).toBe('ex-machina.anthropic-auth')
	expect(plugin.setup).toBeFunction()
})

test('scopes both HTTP hooks to Anthropic so OpenAI can use WebSockets', async () => {
	const hooks = []
	const integrationMethods = []
	const registration = { async dispose() {} }

	await plugin.setup({
		integration: {
			async transform(apply) {
				apply({
					method: {
						update(method) {
							integrationMethods.push(method)
						},
					},
				})
				return registration
			},
		},
		session: {
			async hook(name, callback, options) {
				expect(callback).toBeFunction()
				hooks.push({ name, options })
				return registration
			},
		},
	})

	expect(integrationMethods).toHaveLength(1)
	expect(integrationMethods[0].integrationID).toBe('anthropic')
	expect(hooks).toEqual([
		{ name: 'http.request', options: { providerID: 'anthropic' } },
		{ name: 'http.response', options: { providerID: 'anthropic' } },
	])
})
