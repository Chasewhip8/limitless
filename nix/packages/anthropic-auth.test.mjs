import { expect, test } from 'bun:test'
import plugin from './dist/anthropic-auth.js'

// Verifies patches/opencode-anthropic-auth-provider-hooks.patch: OpenCode disables
// WebSockets for every provider matched by an HTTP hook.
test('scopes both HTTP hooks to Anthropic so OpenAI can use WebSockets', async () => {
	const hooks = []
	const registration = { async dispose() {} }
	const cleanup = await plugin.setup({
		integration: {
			async transform(apply) {
				apply({ method: { update() {} } })
				return registration
			},
			connection: {
				async active() {
					return undefined
				},
				async resolve() {
					return undefined
				},
			},
		},
		session: {
			async hook(name, _callback, options) {
				hooks.push({ name, options })
				return registration
			},
		},
	})
	try {
		expect(hooks).toEqual([
			{ name: 'http.request', options: { providerID: 'anthropic' } },
			{ name: 'http.response', options: { providerID: 'anthropic' } },
		])
	} finally {
		await cleanup?.()
	}
})
