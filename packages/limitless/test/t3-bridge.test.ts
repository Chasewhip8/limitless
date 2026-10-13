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
import { coordinateSession } from '../t3/requests'

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

async function jsonBody(request: IncomingMessage) {
	const chunks: Buffer[] = []
	for await (const chunk of request) chunks.push(Buffer.from(chunk))
	return JSON.parse(Buffer.concat(chunks).toString('utf8'))
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
	expect(calls).toBe(0)
	const response = await fetch(`${bridge.url}/api/info`, {
		headers: { authorization: frontAuth, 'x-opencode-directory': '/project' },
	})
	expect(response.status).toBe(409)
	expect(await response.json()).toEqual({ error: 'fixture conflict' })
	expect(calls).toBe(1)
})

test('does not forward a permission PATCH when the policy RPC is unavailable', async () => {
	const paths: string[] = []
	const { bridge } = await fixture((request, response) => {
		paths.push(`${request.method} ${request.url}`)
		if (request.url === '/api/session/ses_test') {
			json(response, { data: { id: 'ses_test', location: { directory: '/actual' } } })
			return
		}
		expect(request.headers['x-opencode-directory']).toBe(encodeURIComponent('/actual'))
		json(response, { type: 'rpc.unavailable' }, 400)
	})
	const response = await fetch(`${bridge.url}/api/session/ses_test`, {
		method: 'PATCH',
		headers: { authorization: frontAuth, 'content-type': 'application/json' },
		body: JSON.stringify({ permissions: [] }),
	})
	expect(response.status).toBe(400)
	expect(await response.json()).toEqual({ type: 'rpc.unavailable' })
	expect(paths).toEqual([
		'GET /api/session/ses_test',
		'POST /api/rpc/limitless.t3/updatePermissions',
	])
})

test('replaces only the named T3 instruction entry before persistence', async () => {
	const stored = new Map<string, unknown>()
	const { bridge } = await fixture((request, response) => {
		void (async () => {
			if (request.url === '/api/session/active') {
				json(response, { data: {} })
				return
			}
			if (request.method === 'GET') {
				json(response, { data: { id: 'ses_test', location: { directory: '/project' } } })
				return
			}
			if (request.url?.startsWith('/api/rpc/')) {
				json(response, { output: null })
				return
			}
			stored.set(request.url ?? '', await jsonBody(request))
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
	await bridge.close()
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
			const selection = await jsonBody(request)
			if (typeof selection?.agent !== 'string') throw new Error('Invalid agent fixture')
			currentAgent = selection.agent
			selections.push(selection)
			response.writeHead(204).end()
		})()
	})
	for (const agent of ['plan', 'build', 'build']) {
		const response = await fetch(`${bridge.url}/api/session/ses_test/agent`, {
			method: 'POST',
			headers: { authorization: frontAuth, 'content-type': 'application/json' },
			body: JSON.stringify({ agent }),
		})
		expect(response.status).toBe(204)
	}
	expect(selections).toEqual([{ agent: 'plan' }, { agent: 'limitless' }])
})

test('preparation never replaces a permission snapshot read outside the backend queue', async () => {
	const original = [
		{ action: 't3-code-*', resource: '*', effect: 'deny' },
		{ action: 't3-code-old_namespace_*', resource: '*', effect: 'allow' },
	]
	const grant = { action: 'read', resource: 'concurrent-grant', effect: 'allow' }
	let stored = original
	const paths: string[] = []
	const { backendURL } = await fixture((request, response) => {
		paths.push(request.url ?? '')
		if (request.method === 'GET') {
			json(response, {
				data: { id: 'ses_test', location: { directory: '/project' }, permissions: stored },
			})
			stored = [...stored, grant]
			return
		}
		request.resume()
		expect(request.url).toBe('/api/rpc/limitless.t3/prepareSession')
		json(response, { output: null })
	})
	await coordinateSession(
		{ url: backendURL, headers: { authorization: backendAuth } },
		'ses_test',
		undefined,
		new AbortController().signal,
	)
	expect(stored).toContain(grant)
	expect(paths).toEqual(['/api/session/ses_test', '/api/rpc/limitless.t3/prepareSession'])
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

test('shutdown detaches without interrupting any session or stopping the service', async () => {
	const interrupted: string[] = []
	const { bridge, backendURL } = await fixture((request, response) => {
		if (request.url === '/api/info') {
			json(response, { version: '2.0.19' })
			return
		}
		if (request.method === 'POST' && request.url === '/api/session') {
			request.resume()
			json(response, { data: { id: 'ses_owned', location: { directory: '/project' } } })
			return
		}
		if (request.url === '/api/session/active') {
			json(response, { data: { ses_owned: {}, ses_child: {}, ses_unrelated: {} } })
			return
		}
		const id = request.url?.split('/')[3]
		if (request.method === 'POST' && request.url?.endsWith('/interrupt')) {
			request.resume()
			if (id === undefined) throw new Error('Missing interrupted session')
			interrupted.push(id)
			response.writeHead(204).end()
			return
		}
		json(response, { data: { ...(id === 'ses_child' ? { parentID: 'ses_owned' } : {}) } })
	})
	const response = await fetch(`${bridge.url}/api/session`, {
		method: 'POST',
		headers: { authorization: frontAuth, 'content-type': 'application/json' },
		body: '{}',
	})
	expect(response.status).toBe(200)
	await response.json()
	await bridge.close()
	expect(interrupted).toEqual([])
	expect((await fetch(new URL('/api/info', backendURL))).status).toBe(200)
})

test('forwards upgraded connections and closes both sides', async () => {
	const { bridge, backend } = await fixture((_request, response) => response.writeHead(404).end())
	let markClosed: (() => void) | undefined
	const backendClosed = new Promise<void>((resolve) => {
		markClosed = resolve
	})
	backend.on('upgrade', (request, socket) => {
		expect(request.headers.authorization).toBe(backendAuth)
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
		)
		socket.on('data', (data) => socket.write(data))
		socket.once('end', () => socket.end())
		socket.once('close', () => markClosed?.())
	})
	const request = httpRequest(`${bridge.url}/socket`, {
		headers: { authorization: frontAuth, connection: 'Upgrade', upgrade: 'websocket' },
	})
	const upgraded = once(request, 'upgrade')
	request.end()
	const [, socket] = await upgraded
	const data = once(socket, 'data')
	socket.write('unchanged payload')
	expect((await data)[0].toString()).toBe('unchanged payload')
	socket.destroy()
	await backendClosed
})

test('upgrade requests cannot redirect backend authentication to a foreign origin', async () => {
	let foreignCalls = 0
	const foreign = await fixture((_request, response) => {
		foreignCalls++
		json(response, {})
	})
	const { bridge, backend } = await fixture((_request, response) => response.writeHead(404).end())
	let closed: (() => void) | undefined
	const backendClosed = new Promise<void>((resolve) => {
		closed = resolve
	})
	backend.on('upgrade', (request, socket) => {
		expect(request.url).toBe(`//${foreign.backendURL.host}/socket`)
		expect(request.headers.authorization).toBe(backendAuth)
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
		)
		socket.once('end', () => socket.end())
		socket.once('close', () => closed?.())
	})
	await new Promise<void>((resolve, reject) => {
		const request = httpRequest(bridge.url, {
			path: `/a/..//${foreign.backendURL.host}/socket`,
			headers: { authorization: frontAuth, connection: 'Upgrade', upgrade: 'websocket' },
		})
		request.once('upgrade', (_response, socket) => {
			socket.destroy()
			resolve()
		})
		request.once('response', (response) => {
			response.resume()
			reject(new Error('Upgrade was not forwarded to the backend'))
		})
		request.once('error', reject)
		request.end()
	})
	await backendClosed
	expect(foreignCalls).toBe(0)
})
