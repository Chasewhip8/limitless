import { once } from 'node:events'
import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http'
import { afterEach, expect, test } from 'vitest'
import { startT3Bridge } from '../t3/bridge'
import { T3_CONTEXT } from '../t3/instructions'
import { canonicalT3Namespace } from '../t3/permissions'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close()
})

const frontAuth = `Basic ${Buffer.from('opencode:front').toString('base64')}`
const backendAuth = `Basic ${Buffer.from('opencode:backend').toString('base64')}`

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
	const backend = createServer(handler)
	backend.listen(0, '127.0.0.1')
	await once(backend, 'listening')
	const address = backend.address()
	if (address === null || typeof address === 'string') throw new Error('Missing fixture address')
	const url = new URL(`http://127.0.0.1:${address.port}`)
	cleanup.push(
		() =>
			new Promise<void>((resolve, reject) => {
				backend.close((error) => (error ? reject(error) : resolve()))
				backend.closeAllConnections()
			}),
	)
	const bridge = await startT3Bridge({
		backend: async () => ({ url, headers: { authorization: backendAuth } }),
		password: 'front',
	})
	cleanup.push(bridge.close)
	return { bridge, backend, backendURL: url }
}

async function text(request: IncomingMessage) {
	const chunks: Buffer[] = []
	for await (const chunk of request) chunks.push(Buffer.from(chunk))
	return Buffer.concat(chunks).toString('utf8')
}

function json(response: ServerResponse, value: unknown, status = 200) {
	response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
}

test('authenticates the caller and preserves upstream errors without leaking either password', async () => {
	let calls = 0
	const { bridge } = await fixture((request, response) => {
		calls++
		expect(request.headers.authorization).toBe(backendAuth)
		expect(request.headers['x-opencode-directory']).toBe('/project')
		json(response, { error: 'fixture conflict' }, 409)
	})
	expect((await fetch(`${bridge.url}/api/info`)).status).toBe(401)
	expect(
		(await fetch(`${bridge.url}/api/info`, { headers: { authorization: backendAuth } })).status,
	).toBe(401)
	expect(calls).toBe(0)
	const response = await fetch(`${bridge.url}/api/info`, {
		headers: { authorization: frontAuth, 'x-opencode-directory': '/project' },
	})
	expect(response.status).toBe(409)
	expect(await response.json()).toEqual({ error: 'fixture conflict' })
	expect(calls).toBe(1)
})

test('forwards session creation and permission writes byte for byte', async () => {
	const received: Array<{
		method: string | undefined
		url: string | undefined
		type: string | undefined
		body: string
	}> = []
	const { bridge } = await fixture((request, response) => {
		void (async () => {
			received.push({
				method: request.method,
				url: request.url,
				type: request.headers['content-type'],
				body: await text(request),
			})
			response.writeHead(204).end()
		})()
	})
	const permissions = JSON.stringify({
		title: null,
		permissions: [{ action: '*', resource: '*', effect: 'allow' }],
	})
	for (const [method, path] of [
		['POST', '/api/session?directory=%2Fproject'],
		['PATCH', '/api/session/ses_test'],
	] as const) {
		const response = await fetch(`${bridge.url}${path}`, {
			method,
			headers: { authorization: frontAuth, 'content-type': 'application/json' },
			body: permissions,
		})
		expect(response.status).toBe(204)
	}
	expect(received).toEqual([
		{
			method: 'POST',
			url: '/api/session?directory=%2Fproject',
			type: 'application/json',
			body: permissions,
		},
		{ method: 'PATCH', url: '/api/session/ses_test', type: 'application/json', body: permissions },
	])
})

test('replaces only the named T3 instruction entry before persistence', async () => {
	const stored = new Map<string, unknown>()
	const { bridge } = await fixture((request, response) => {
		void (async () => {
			stored.set(request.url ?? '', JSON.parse(await text(request)))
			response.writeHead(204).end()
		})()
	})
	for (const key of ['t3-code', 'user-context']) {
		const response = await fetch(
			`${bridge.url}/api/experimental/session/ses_test/instructions/entries/${key}`,
			{
				method: 'PUT',
				headers: { authorization: frontAuth, 'content-type': 'application/json' },
				body: JSON.stringify({ value: 'original instructions' }),
			},
		)
		expect(response.status).toBe(204)
	}
	expect(stored.get('/api/experimental/session/ses_test/instructions/entries/t3-code')).toEqual({
		value: T3_CONTEXT,
	})
	expect(
		stored.get('/api/experimental/session/ses_test/instructions/entries/user-context'),
	).toEqual({ value: 'original instructions' })

	const malformed = await fetch(
		`${bridge.url}/api/experimental/session/ses_test/instructions/entries/t3-code`,
		{ method: 'PUT', headers: { authorization: frontAuth }, body: '["not an object"]' },
	)
	expect(malformed.status).toBe(400)
	expect(stored.size).toBe(2)
})

test('hashes underscore-containing T3 MCP server names in both directions of their lifecycle', async () => {
	const paths: string[] = []
	const { bridge } = await fixture((request, response) => {
		paths.push(`${request.method} ${request.url}`)
		request.resume()
		response.writeHead(204).end()
	})
	const forked = 't3-code-thread_fork'
	for (const [method, name] of [
		['PUT', forked],
		['DELETE', forked],
		['PUT', 't3-code-thread'],
		['PUT', 'notion-work'],
	] as const) {
		const response = await fetch(`${bridge.url}/api/experimental/mcp/${name}`, {
			method,
			headers: { authorization: frontAuth, 'content-type': 'application/json' },
			body: method === 'PUT' ? '{"config":{}}' : null,
		})
		expect(response.status).toBe(204)
	}
	const hashed = canonicalT3Namespace(forked)
	expect(hashed).not.toBe(forked)
	expect(paths).toEqual([
		`PUT /api/experimental/mcp/${hashed}`,
		`DELETE /api/experimental/mcp/${hashed}`,
		'PUT /api/experimental/mcp/t3-code-thread',
		'PUT /api/experimental/mcp/notion-work',
	])
})

test('streams events and propagates downstream cancellation', async () => {
	let finishStream: (() => void) | undefined
	let second: (() => void) | undefined
	const cancelled = new Promise<void>((resolve) => {
		finishStream = resolve
	})
	const { bridge } = await fixture((_request, response) => {
		response.writeHead(200, { 'content-type': 'text/event-stream' })
		response.write('data: first\n\n')
		second = () => {
			response.write('data: second\n\n')
		}
		response.once('close', () => finishStream?.())
	})
	const controller = new AbortController()
	const response = await fetch(`${bridge.url}/api/event`, {
		headers: { authorization: frontAuth },
		signal: controller.signal,
	})
	expect(response.headers.get('content-type')).toBe('text/event-stream')
	const reader = response.body?.getReader()
	if (!reader || !second) throw new Error('Missing event stream')
	expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n')
	second()
	expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: second\n\n')
	controller.abort()
	await cancelled
})

test('normal-mode agent selection restores the configured default and encodes location headers', async () => {
	const directory = '/project/literal%20日本語'
	const selections: unknown[] = []
	let currentAgent: string | undefined
	const { bridge } = await fixture((request, response) => {
		void (async () => {
			if (request.url === '/api/agent') {
				expect(request.headers.authorization).toBe(backendAuth)
				expect(request.headers['x-opencode-directory']).toBe(encodeURIComponent(directory))
				json(response, { data: [{ id: 'limitless', mode: 'primary', hidden: false }] })
				return
			}
			if (request.method === 'GET') {
				json(response, {
					data: {
						id: 'ses_test',
						location: { directory },
						...(currentAgent === undefined ? {} : { agent: currentAgent }),
					},
				})
				return
			}
			const selection = JSON.parse(await text(request))
			currentAgent = selection.agent
			selections.push(selection)
			response.writeHead(204).end()
		})()
	})
	for (const agent of ['build', 'plan', 'build', 'build', 'unit']) {
		const response = await fetch(`${bridge.url}/api/session/ses_test/agent`, {
			method: 'POST',
			headers: { authorization: frontAuth, 'content-type': 'application/json' },
			body: JSON.stringify({ agent }),
		})
		expect(response.status).toBe(204)
	}
	expect(selections).toEqual([{ agent: 'plan' }, { agent: 'limitless' }, { agent: 'unit' }])
})

test('caller-selected URL forms cannot redirect backend credentials to another origin', async () => {
	let foreignCalls = 0
	const foreign = await fixture((_request, response) => {
		foreignCalls++
		json(response, {})
	})
	const paths: string[] = []
	const { bridge } = await fixture((request, response) => {
		expect(request.headers.authorization).toBe(backendAuth)
		paths.push(request.url ?? '')
		json(response, {})
	})
	for (const path of [
		`/a/..//${foreign.backendURL.host}/api/info`,
		`http://${foreign.backendURL.host}/api/info`,
	]) {
		await new Promise<void>((resolve, reject) => {
			const request = httpRequest(
				bridge.url,
				{ path, headers: { authorization: frontAuth } },
				(response) => {
					expect(response.statusCode).toBe(200)
					response.resume()
					response.once('end', resolve)
				},
			)
			request.once('error', reject)
			request.end()
		})
	}
	expect(foreignCalls).toBe(0)
	expect(paths).toEqual([`//${foreign.backendURL.host}/api/info`, '/api/info'])
})

test('rejects upgrades without contacting the service', async () => {
	let calls = 0
	const { bridge, backend } = await fixture((_request, response) => {
		calls++
		response.writeHead(404).end()
	})
	backend.on('upgrade', (_request, socket) => {
		calls++
		socket.destroy()
	})
	const status = await new Promise<number | undefined>((resolve, reject) => {
		const request = httpRequest(`${bridge.url}/socket`, {
			headers: { authorization: frontAuth, connection: 'Upgrade', upgrade: 'websocket' },
		})
		request.once('upgrade', () => reject(new Error('Upgrade was forwarded')))
		request.once('response', (response) => {
			response.resume()
			resolve(response.statusCode)
		})
		request.once('error', reject)
		request.end()
	})
	expect(status).toBe(501)
	expect(calls).toBe(0)
})

test('shutdown detaches promptly without stopping the service or its event streams', async () => {
	const interrupted: string[] = []
	let streamClosed: (() => void) | undefined
	const detached = new Promise<void>((resolve) => {
		streamClosed = resolve
	})
	const { bridge, backendURL } = await fixture((request, response) => {
		if (request.url === '/api/event') {
			response.writeHead(200, { 'content-type': 'text/event-stream' })
			response.write('data: open\n\n')
			response.once('close', () => streamClosed?.())
			return
		}
		if (request.url?.endsWith('/interrupt')) interrupted.push(request.url)
		request.resume()
		json(response, { version: '2.0.32' })
	})
	const events = await fetch(`${bridge.url}/api/event`, { headers: { authorization: frontAuth } })
	await events.body?.getReader().read()
	const started = Date.now()
	await bridge.close()
	await detached
	expect(Date.now() - started).toBeLessThan(5000)
	expect(interrupted).toEqual([])
	expect((await fetch(new URL('/api/info', backendURL))).status).toBe(200)
})

test('a client that leaves before the service answers cancels the forwarded request', async () => {
	let upstreamClosed: (() => void) | undefined
	const cancelled = new Promise<void>((resolve) => {
		upstreamClosed = resolve
	})
	const { bridge } = await fixture((request) => {
		// Never answer: the service is still working when the client leaves.
		request.once('close', () => upstreamClosed?.())
	})
	const controller = new AbortController()
	const pending = fetch(`${bridge.url}/api/experimental/session/ses_test/wait`, {
		method: 'POST',
		headers: { authorization: frontAuth },
		signal: controller.signal,
	}).catch(() => undefined)
	await new Promise((resolve) => setTimeout(resolve, 100))
	controller.abort()
	await pending
	await cancelled
	const started = Date.now()
	await bridge.close()
	expect(Date.now() - started).toBeLessThan(3000)
})

test('a service that rejects a body before reading it still answers T3', async () => {
	const { bridge } = await fixture((_request, response) => {
		json(response, { error: 'too large' }, 413)
	})
	const response = await fetch(`${bridge.url}/api/session/ses_test/prompt`, {
		method: 'POST',
		headers: { authorization: frontAuth, 'content-type': 'application/json' },
		body: JSON.stringify({ text: 'x'.repeat(256 * 1024) }),
	})
	expect(response.status).toBe(413)
	expect(await response.json()).toEqual({ error: 'too large' })
})

test('a response the service cuts off never reaches T3 as complete', async () => {
	const { bridge } = await fixture((_request, response) => {
		response.writeHead(200, { 'content-type': 'text/event-stream' })
		response.write('data: partial\n\n', () => setTimeout(() => response.destroy(), 50))
	})
	const response = await fetch(`${bridge.url}/api/event`, { headers: { authorization: frontAuth } })
	expect(response.status).toBe(200)
	await expect(response.text()).rejects.toThrow()
})

test('hop-by-hop headers stop at the bridge in both directions', async () => {
	let forwarded: IncomingMessage['headers'] | undefined
	const { bridge } = await fixture((request, response) => {
		forwarded = request.headers
		request.resume()
		response
			.writeHead(200, {
				'content-type': 'application/json',
				connection: 'x-response-hop',
				'x-response-hop': '1',
				'proxy-authenticate': 'Basic',
				'x-end-to-end': 'kept',
			})
			.end('{}')
	})
	const headers = await new Promise<IncomingMessage['headers']>((resolve, reject) => {
		const request = httpRequest(
			`${bridge.url}/api/info`,
			{
				headers: {
					authorization: frontAuth,
					connection: 'x-request-hop',
					'x-request-hop': '1',
					te: 'trailers',
					'x-end-to-end': 'kept',
				},
			},
			(response) => {
				response.resume()
				resolve(response.headers)
			},
		)
		request.once('error', reject)
		request.end()
	})
	expect(forwarded?.['x-request-hop']).toBeUndefined()
	expect(forwarded?.te).toBeUndefined()
	expect(forwarded?.['x-end-to-end']).toBe('kept')
	expect(headers['x-response-hop']).toBeUndefined()
	expect(headers['proxy-authenticate']).toBeUndefined()
	expect(headers['x-end-to-end']).toBe('kept')
})

test('a body without a declared type is forwarded without one', async () => {
	let received: { type: string | undefined; body: string } | undefined
	const { bridge } = await fixture((request, response) => {
		void (async () => {
			received = { type: request.headers['content-type'], body: await text(request) }
			response.writeHead(204).end()
		})()
	})
	await new Promise<void>((resolve, reject) => {
		const request = httpRequest(
			`${bridge.url}/api/session/ses_test/prompt`,
			{ method: 'POST', headers: { authorization: frontAuth } },
			(response) => {
				response.resume()
				response.once('end', resolve)
			},
		)
		request.once('error', reject)
		request.end('untyped')
	})
	expect(received).toEqual({ type: undefined, body: 'untyped' })
})

test('malformed T3 paths are rejected and a lookup error reaches T3 as the service sent it', async () => {
	const { bridge } = await fixture((request, response) => {
		request.resume()
		json(response, { name: 'Session.NotFoundError', data: { sessionID: 'ses_gone' } }, 404)
	})
	const malformed = await fetch(`${bridge.url}/api/experimental/mcp/t3-code-%E0%A4%A`, {
		method: 'DELETE',
		headers: { authorization: frontAuth },
	})
	expect(malformed.status).toBe(400)
	const selection = await fetch(`${bridge.url}/api/session/ses_gone/agent`, {
		method: 'POST',
		headers: { authorization: frontAuth, 'content-type': 'application/json' },
		body: JSON.stringify({ agent: 'build' }),
	})
	expect(selection.status).toBe(404)
	expect(await selection.json()).toEqual({
		name: 'Session.NotFoundError',
		data: { sessionID: 'ses_gone' },
	})
})

test('separate Set-Cookie fields and Connection-nominated request headers keep their meaning', async () => {
	let forwardedType: string | undefined
	const { bridge } = await fixture((request, response) => {
		forwardedType = request.headers['content-type']
		request.resume()
		response.writeHead(204, [
			['set-cookie', 'first=1; Path=/'],
			['set-cookie', 'second=2; Path=/'],
		])
		response.end()
	})
	const response = await new Promise<IncomingMessage>((resolve, reject) => {
		// fetch refuses to send a Connection header, so use a raw request.
		const request = httpRequest(
			`${bridge.url}/api/session/ses_test/prompt`,
			{
				method: 'POST',
				headers: {
					authorization: frontAuth,
					connection: 'content-type',
					'content-type': 'application/json',
				},
			},
			(answer) => {
				answer.resume()
				answer.once('end', () => resolve(answer))
			},
		)
		request.once('error', reject)
		request.end('{}')
	})
	expect(response.statusCode).toBe(204)
	expect(response.headers['set-cookie']).toEqual(['first=1; Path=/', 'second=2; Path=/'])
	expect(forwardedType).toBeUndefined()
})
