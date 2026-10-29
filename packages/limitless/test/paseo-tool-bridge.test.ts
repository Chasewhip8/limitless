import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Effect, Exit } from 'effect'
import { afterEach, expect, test } from 'vitest'
import { executeTool, fetchManifest, sessionBinding } from '../paseo/tool-bridge'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close()
})

async function text(request: IncomingMessage) {
	const chunks: Buffer[] = []
	for await (const chunk of request) chunks.push(Buffer.from(chunk))
	return Buffer.concat(chunks).toString('utf8')
}

function json(response: ServerResponse, value: unknown, status = 200) {
	response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
}

/** Answers like Paseo's daemon-side bridge (packages/server/src/server/agent/providers/opencode/bridge.ts). */
async function paseo(
	handler: (request: IncomingMessage, body: string, response: ServerResponse) => void,
) {
	const server = createServer(async (request, response) => {
		if (request.headers.authorization !== 'Bearer token')
			return json(response, { error: 'Unauthorized' }, 401)
		handler(request, await text(request), response)
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const address = server.address()
	if (address === null || typeof address === 'string') throw new Error('Missing fixture address')
	cleanup.push(
		() =>
			new Promise<void>((resolve) => {
				server.close(() => resolve())
				server.closeAllConnections()
			}),
	)
	return { baseUrl: `http://127.0.0.1:${address.port}`, token: 'token' }
}

test('reads the tool manifest and rejects the wrong token', async () => {
	const bridge = await paseo((request, _body, response) => {
		expect(request.url).toBe('/_internal/opencode/tools')
		json(response, {
			tools: [
				{
					name: 'list_agents',
					description: 'List',
					inputSchema: { type: 'object' },
					title: 'List',
				},
			],
		})
	})
	expect(await Effect.runPromise(fetchManifest(bridge))).toEqual([
		{ name: 'list_agents', description: 'List', inputSchema: { type: 'object' }, title: 'List' },
	])
	const exit = await Effect.runPromiseExit(fetchManifest({ ...bridge, token: 'wrong' }))
	expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain('Unauthorized')
})

test('a 404 binding is unbound; a bound session lists its allowed tools', async () => {
	const bridge = await paseo((request, _body, response) => {
		if (request.url === '/_internal/opencode/sessions/ses_bound/context?tools')
			return json(response, { env: { PASEO_AGENT_ID: 'a1' }, tools: ['send_agent_prompt'] })
		json(response, { error: 'OpenCode session is not bound to a Paseo agent' }, 404)
	})
	const bound = await Effect.runPromise(sessionBinding(bridge, 'ses_bound'))
	expect(bound._tag === 'Bound' ? [...bound.tools] : bound).toEqual(['send_agent_prompt'])
	expect(await Effect.runPromise(sessionBinding(bridge, 'ses_other'))).toEqual({ _tag: 'Unbound' })
})

test('an unreachable daemon is an error, never a binding', async () => {
	const exit = await Effect.runPromiseExit(
		sessionBinding({ baseUrl: 'http://127.0.0.1:9', token: 'token' }, 'ses_bound'),
	)
	expect(Exit.isFailure(exit)).toBe(true)
})

test('executes a tool with raw arguments and reports Paseo’s validation issues', async () => {
	const bridge = await paseo((request, body, response) => {
		if (request.url === '/_internal/opencode/sessions/ses_bound/tools/create_agent') {
			expect(request.method).toBe('POST')
			const input = JSON.parse(body)
			if (input.title === undefined)
				return json(
					response,
					{ error: 'Invalid tool input', issues: [{ path: ['title'], message: 'Required' }] },
					400,
				)
			return json(response, {
				content: [
					{ type: 'text', text: 'created' },
					{ type: 'image', data: 'aGk=', mimeType: 'image/png' },
					{ type: 'resource_link', uri: 'https://example.test/document', name: 'Document' },
				],
				structuredContent: { agentId: 'a2' },
			})
		}
		json(response, { error: 'Not found' }, 404)
	})
	expect(
		await Effect.runPromise(executeTool(bridge, 'ses_bound', 'create_agent', { title: 'Example' })),
	).toEqual({
		content: [
			{ type: 'text', text: 'created' },
			{ type: 'image', data: 'aGk=', mimeType: 'image/png' },
			{ type: 'resource_link', uri: 'https://example.test/document', name: 'Document' },
		],
	})
	const exit = await Effect.runPromiseExit(executeTool(bridge, 'ses_bound', 'create_agent', {}))
	expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain(
		'Invalid tool input: title: Required',
	)
})
