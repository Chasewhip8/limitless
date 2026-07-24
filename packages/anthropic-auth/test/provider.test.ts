import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const workspace = new URL('../../..', import.meta.url).pathname
const decodeOutput = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

async function runWithBun(script: string): Promise<unknown> {
	const result = await execFileAsync('bun', ['--eval', script], {
		cwd: workspace,
		encoding: 'utf8',
	})
	return decodeOutput(result.stdout.trim())
}

describe('native provider package', () => {
	it('exports the V2 plugin and native model contract from the same entrypoint', async () => {
		const result = await runWithBun(`
			import plugin, { model } from './packages/anthropic-auth/index.ts'
			console.log(JSON.stringify({ id: plugin.id, model: typeof model }))
		`)
		expect(result).toEqual({ id: 'limitless.anthropic-auth', model: 'function' })
	})

	it('retains stock API-key auth, overlays, and Anthropic variant options when unmarked', async () => {
		const result = await runWithBun(`
			import { Effect } from 'effect'
			import { Headers } from 'effect/unstable/http'
			import { model } from './packages/anthropic-auth/src/provider.ts'

			const selected = model('claude-sonnet-4-5', {
				apiKey: 'standard-key',
				baseURL: 'https://anthropic.example/v1',
				headers: { 'x-custom': 'present' },
				body: { custom_extension: true },
				limits: { context: 200000, output: 8192 },
				thinking: { type: 'enabled', budgetTokens: 4096 },
				effort: 'high',
				customOption: { enabled: true },
				providerOptions: {
					anthropic: { existingOption: 'kept' },
					gateway: { trace: true },
				},
			})
			const headers = await Effect.runPromise(selected.route.auth.apply({
				request: {}, method: 'POST', url: 'https://anthropic.example/v1/messages', body: '{}',
				headers: Headers.empty,
			}))
			console.log(JSON.stringify({
				route: selected.route.id,
				baseURL: selected.route.endpoint.baseURL,
				query: selected.route.endpoint.query,
				xApiKey: headers['x-api-key'],
				authorization: headers.authorization,
				body: selected.route.defaults.http?.body,
				providerOptions: selected.route.defaults.providerOptions,
			}))
		`)

		expect(result).toMatchObject({
			route: 'anthropic-messages',
			baseURL: 'https://anthropic.example/v1',
			xApiKey: 'standard-key',
			body: { custom_extension: true },
			providerOptions: {
				anthropic: {
					existingOption: 'kept',
					thinking: { type: 'enabled', budgetTokens: 4096 },
					effort: 'high',
					customOption: { enabled: true },
				},
				gateway: { trace: true },
			},
		})
	})

	it('does not enable Max behavior for an unmarked OAuth-shaped apiKey', async () => {
		const result = await runWithBun(`
			import { Effect } from 'effect'
			import { Headers } from 'effect/unstable/http'
			import { model } from './packages/anthropic-auth/src/provider.ts'

			const selected = model('claude-sonnet-4-5', { apiKey: 'unmarked-oauth-access' })
			const headers = await Effect.runPromise(selected.route.auth.apply({
				request: {}, method: 'POST', url: 'https://api.anthropic.com/v1/messages', body: '{}',
				headers: Headers.empty,
			}))
			console.log(JSON.stringify({
				route: selected.route.id,
				query: selected.route.endpoint.query,
				xApiKey: headers['x-api-key'],
				authorization: headers.authorization,
			}))
		`)
		expect(result).toEqual({ route: 'anthropic-messages', xApiKey: 'unmarked-oauth-access' })
	})

	it('uses bearer auth, OAuth headers, beta query, and the configured native baseURL for marked Max', async () => {
		const result = await runWithBun(`
			import { Effect } from 'effect'
			import { Headers } from 'effect/unstable/http'
			import { MAX_METADATA_KEY } from './packages/anthropic-auth/src/constants.ts'
			import { model } from './packages/anthropic-auth/src/provider.ts'

			const selected = model('claude-sonnet-4-5', {
				apiKey: 'max-access',
				baseURL: 'https://proxy.example/v1',
				headers: { 'anthropic-beta': 'custom-beta', 'x-api-key': 'must-be-removed' },
				thinking: { type: 'adaptive', display: 'summarized' },
				customOption: 'preserved',
				[MAX_METADATA_KEY]: { mode: 'max', profile: 'claude-code-2.1.87' },
			})
			const headers = await Effect.runPromise(selected.route.auth.apply({
				request: {}, method: 'POST', url: 'https://proxy.example/v1/messages?beta=true', body: '{}',
				headers: Headers.fromInput(selected.route.defaults.http?.headers),
			}))
			console.log(JSON.stringify({
				route: selected.route.id,
				baseURL: selected.route.endpoint.baseURL,
				query: selected.route.endpoint.query,
				authorization: headers.authorization,
				xApiKey: headers['x-api-key'],
				userAgent: headers['user-agent'],
				beta: headers['anthropic-beta'],
				providerOptions: selected.route.defaults.providerOptions,
			}))
		`)

		expect(result).toMatchObject({
			route: 'limitless-anthropic-max-messages',
			baseURL: 'https://proxy.example/v1',
			query: { beta: 'true' },
			authorization: 'Bearer max-access',
			userAgent: 'claude-cli/2.1.87 (external, cli)',
			providerOptions: {
				anthropic: {
					thinking: { type: 'adaptive', display: 'summarized' },
					customOption: 'preserved',
				},
			},
		})
		expect(result).not.toHaveProperty('xApiKey')
		expect(result).toMatchObject({
			beta: expect.stringContaining('oauth-2025-04-20'),
		})
		expect(result).toMatchObject({ beta: expect.stringContaining('custom-beta') })
	})

	it('maps decoded tool starts before delegating to the stock Anthropic stream step', async () => {
		const result = await runWithBun(`
			import { LLM } from './packages/anthropic-auth/node_modules/@opencode-ai/ai/dist/index.js'
			import { Effect, Schema } from 'effect'
			import { model } from './packages/anthropic-auth/src/provider.ts'
			import { maxOAuthProtocol } from './packages/anthropic-auth/src/protocol.ts'

			const decode = Schema.decodeUnknownSync(maxOAuthProtocol.stream.event)
			const event = decode(JSON.stringify({
				type: 'content_block_start', index: 0,
				content_block: { type: 'tool_use', id: 'tool-1', name: 'mcp_Bash', input: {} },
			}))
			const request = LLM.request({ model: model('claude-sonnet-4-5', { apiKey: 'key' }), prompt: 'Hi' })
			const [, events] = await Effect.runPromise(maxOAuthProtocol.stream.step(
				maxOAuthProtocol.stream.initial(request), event,
			))
			console.log(JSON.stringify(events))
		`)
		expect(result).toEqual([
			{ type: 'step-start', index: 0 },
			{ type: 'tool-input-start', id: 'tool-1', name: 'bash' },
		])
	})

	it('rejects marked metadata without an access token', async () => {
		const result = await runWithBun(`
			import { MAX_METADATA_KEY } from './packages/anthropic-auth/src/constants.ts'
			import { model } from './packages/anthropic-auth/src/provider.ts'
			let message = ''
			try { model('claude-sonnet-4-5', { [MAX_METADATA_KEY]: { mode: 'max' } }) }
			catch (error) { message = error instanceof Error ? error.message : String(error) }
			console.log(JSON.stringify({ message }))
		`)
		expect(result).toMatchObject({ message: expect.stringContaining('reconnect Anthropic') })
	})
})
