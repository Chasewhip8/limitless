import { expect, test } from 'bun:test'
import plugin from './dist/anthropic-auth.js'

async function createOAuthPlugin() {
	const hooks = new Map()
	const registration = { async dispose() {} }
	const cleanup = await plugin.setup({
		integration: {
			async transform(apply) {
				apply({ method: { update() {} } })
				return registration
			},
			connection: {
				async active() {
					return { id: 'test-connection' }
				},
				async resolve() {
					return {
						type: 'oauth',
						methodID: 'claude-max',
						refresh: 'test-refresh-token',
						access: 'test-access-token',
						expires: Date.now() + 60_000,
					}
				},
			},
		},
		session: {
			async hook(name, callback) {
				hooks.set(name, callback)
				return registration
			},
		},
	})
	return { requestHook: hooks.get('http.request'), cleanup }
}

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

test('reports the bundled Claude Code version consistently in headers and billing metadata', async () => {
	const { requestHook, cleanup } = await createOAuthPlugin()
	try {
		const event = {
			model: { providerID: 'anthropic', modelID: 'claude-opus-5-5' },
			request: new Request('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				body: JSON.stringify({ messages: [{ role: 'user', content: 'hello world test message' }] }),
			}),
		}
		await requestHook(event)
		expect(event.request.headers.get('user-agent')).toBe('claude-cli/2.1.321 (external, cli)')
		const rewritten = await event.request.json()
		expect(rewritten.system[0].text).toMatch(
			/^x-anthropic-billing-header: cc_version=2\.1\.321\.[a-f0-9]{3};/,
		)
	} finally {
		await cleanup?.()
	}
})

test('rewrites streamed request bodies larger than the former 10 MiB limit', async () => {
	const { requestHook, cleanup } = await createOAuthPlugin()
	try {
		const content = 'x'.repeat(11 * 1024 * 1024)
		const event = {
			model: { providerID: 'anthropic', modelID: 'claude-opus-5-5' },
			request: new Request('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				body: JSON.stringify({ messages: [{ role: 'user', content }] }),
			}),
		}
		await requestHook(event)
		expect(event.request.headers.get('authorization')).toBe('Bearer test-access-token')
		const rewritten = await event.request.json()
		expect(rewritten.messages[0].content).toBe(content)
	} finally {
		await cleanup?.()
	}
})

test.each([
	{ bytes: 128 * 1024 * 1024, accepted: true },
	{ bytes: 128 * 1024 * 1024 + 1, accepted: false },
])('enforces the declared request-size boundary at $bytes bytes', async ({ bytes, accepted }) => {
	const { requestHook, cleanup } = await createOAuthPlugin()
	try {
		const event = {
			model: { providerID: 'anthropic', modelID: 'claude-opus-5-5' },
			request: new Request('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				headers: { 'content-length': String(bytes) },
				body: JSON.stringify({ messages: [{ role: 'user', content: 'hello world test message' }] }),
			}),
		}
		if (!accepted) {
			await expect(requestHook(event)).rejects.toThrow(
				'Anthropic request body exceeds 134217728 byte limit',
			)
			return
		}
		await requestHook(event)
		expect(event.request.headers.get('authorization')).toBe('Bearer test-access-token')
	} finally {
		await cleanup?.()
	}
})
