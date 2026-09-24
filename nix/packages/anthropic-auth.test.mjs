import { expect, test } from 'bun:test'
import plugin from './dist/anthropic-auth.js'

test('bundles the OpenCode 2 Promise plugin', () => {
	expect(plugin.id).toBe('ex-machina.anthropic-auth')
	expect(plugin.setup).toBeFunction()
})

async function withPlugin(version, verify) {
	const previousVersion = process.env.ANTHROPIC_CLAUDE_CODE_VERSION
	if (version === undefined) delete process.env.ANTHROPIC_CLAUDE_CODE_VERSION
	else process.env.ANTHROPIC_CLAUDE_CODE_VERSION = version
	const hooks = new Map()
	const integrationMethods = []
	const registration = { async dispose() {} }
	let cleanup

	try {
		cleanup = await plugin.setup({
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
				connection: {
					async active() {
						return { id: 'test-account', integrationID: 'anthropic' }
					},
					async resolve() {
						return {
							type: 'oauth',
							methodID: 'claude-max',
							access: 'test-access',
							refresh: 'test-refresh',
							expires: Number.MAX_SAFE_INTEGER,
						}
					},
				},
			},
			session: {
				async hook(name, callback, options) {
					expect(callback).toBeFunction()
					hooks.set(name, { callback, options })
					return registration
				},
			},
		})
		expect(cleanup).toBeFunction()
		await verify({ hooks, integrationMethods })
	} finally {
		await cleanup?.()
		if (previousVersion === undefined) delete process.env.ANTHROPIC_CLAUDE_CODE_VERSION
		else process.env.ANTHROPIC_CLAUDE_CODE_VERSION = previousVersion
	}
}

async function requestEvent(hooks) {
	const event = {
		sessionID: 'test-session',
		agent: 'oracle-design',
		model: { providerID: 'anthropic', id: 'test-model' },
		request: new Request('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				messages: [{ role: 'user', content: 'Version compatibility fixture' }],
			}),
		}),
	}
	await hooks.get('http.request').callback(event)
	return event
}

async function expectVersion(request, version) {
	expect(request.headers.get('user-agent')).toBe(`claude-cli/${version} (external, cli)`)
	const body = await request.clone().json()
	expect(body.system[0].text).toContain(`cc_version=${version}.`)
}

async function rejectVersion(hooks, event, reported, required) {
	const responseEvent = {
		...event,
		request: new Request(event.request),
		response: Response.json(
			{
				type: 'error',
				error: {
					type: 'invalid_request_error',
					message: `Claude Code ${reported} does not support this model; version ${required} or newer is required.`,
					details: { error_code: 'claude_code_version_too_old' },
				},
			},
			{ status: 400 },
		),
	}
	await hooks.get('http.response').callback(responseEvent)
	return responseEvent.response
}

test('scopes both HTTP hooks to Anthropic so OpenAI can use WebSockets', async () => {
	await withPlugin(undefined, async ({ hooks, integrationMethods }) => {
		expect(integrationMethods).toHaveLength(1)
		expect(integrationMethods[0].integrationID).toBe('anthropic')
		expect([...hooks].map(([name, { options }]) => ({ name, options }))).toEqual([
			{ name: 'http.request', options: { providerID: 'anthropic' } },
			{ name: 'http.response', options: { providerID: 'anthropic' } },
		])
	})
})

test('bundles version 2.1.280 and marks a newer structured requirement retryable once', async () => {
	await withPlugin(undefined, async ({ hooks }) => {
		const initial = await requestEvent(hooks)
		await expectVersion(initial.request, '2.1.280')
		const rejection = await rejectVersion(hooks, initial, '2.1.280', '2.1.281')
		expect(rejection.headers.get('x-should-retry')).toBe('true')
		expect((await rejection.json()).error.details.error_code).toBe('claude_code_version_too_old')

		const retry = await requestEvent(hooks)
		await expectVersion(retry.request, '2.1.281')
		const secondRejection = await rejectVersion(hooks, retry, '2.1.281', '2.1.282')
		expect(secondRejection.headers.get('x-should-retry')).toBeNull()
	})
})

test('keeps an explicit compatibility override fixed instead of adopting a new requirement', async () => {
	await withPlugin('2.1.280', async ({ hooks }) => {
		const initial = await requestEvent(hooks)
		await expectVersion(initial.request, '2.1.280')
		const rejection = await rejectVersion(hooks, initial, '2.1.280', '2.1.281')
		expect(rejection.headers.get('x-should-retry')).toBeNull()
		const next = await requestEvent(hooks)
		await expectVersion(next.request, '2.1.280')
	})
})
