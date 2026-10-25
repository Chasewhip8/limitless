import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, expect, test } from 'vitest'
import { startBridge } from '../bridge/server'
import { routePaseoRequest } from '../paseo/rewrites'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close()
})

const frontAuth = `Basic ${Buffer.from('opencode:paseo').toString('base64')}`
const backendAuth = `Basic ${Buffer.from('opencode:backend').toString('base64')}`

interface Received {
	readonly method: string | undefined
	readonly url: string | undefined
	readonly directory: string | undefined
	readonly body: string
}

async function text(request: IncomingMessage) {
	const chunks: Buffer[] = []
	for await (const chunk of request) chunks.push(Buffer.from(chunk))
	return Buffer.concat(chunks).toString('utf8')
}

const echoed = async (response: Response) =>
	((await response.json()) as { data: { echoed: unknown } }).data.echoed

function json(response: ServerResponse, value: unknown, status = 200) {
	response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
}

/** A managed service whose default agent is `limitless` and whose sessions start on `research`. */
async function fixture(agents: ReadonlyArray<Record<string, unknown>> = defaultAgents) {
	const received: Received[] = []
	const backend = createServer(async (request, response) => {
		expect(request.headers.authorization).toBe(backendAuth)
		const body = await text(request)
		const directory = request.headers['x-opencode-directory']
		received.push({
			method: request.method,
			url: request.url,
			directory: typeof directory === 'string' ? decodeURIComponent(directory) : undefined,
			body,
		})
		if (request.method === 'GET' && request.url === '/api/agent')
			return json(response, { data: agents })
		if (request.method === 'GET' && request.url === '/api/session/ses_existing')
			return json(response, { data: { location: { directory: '/project' }, agent: 'research' } })
		return json(response, { data: { echoed: body.length > 0 ? JSON.parse(body) : null } })
	})
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
	const bridge = await startBridge({
		client: 'Paseo',
		route: routePaseoRequest,
		backend: async () => ({ url, headers: { authorization: backendAuth } }),
		password: 'paseo',
	})
	cleanup.push(bridge.close)
	const call = (method: string, path: string, body?: unknown) =>
		fetch(`${bridge.url}${path}`, {
			method,
			headers: { authorization: frontAuth, 'content-type': 'application/json' },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		})
	return { received, call }
}

const defaultAgents = [
	{ id: 'limitless', mode: 'primary', hidden: false },
	{ id: 'unit', mode: 'primary', hidden: false },
]

const creation = {
	location: { directory: '/work tree/日本語' },
	title: 'Paseo agent',
	model: { providerID: 'openai', id: 'gpt-6-astra', variant: 'xhigh' },
	permissions: [{ action: '*', resource: '*', effect: 'allow' }],
}

test('session creation drops Paseo permission rules and keeps an explicit agent', async () => {
	const { received, call } = await fixture()
	const response = await call('POST', '/api/session', { ...creation, agent: 'unit' })
	expect(response.status).toBe(200)
	const { permissions: _dropped, ...expected } = { ...creation, agent: 'unit' }
	expect(await echoed(response)).toEqual(expected)
	expect(received.map((entry) => entry.url)).toEqual(['/api/session'])
})

test('session creation with the disabled build agent selects the location default', async () => {
	const { received, call } = await fixture()
	const response = await call('POST', '/api/session', { ...creation, agent: 'build' })
	expect(response.status).toBe(200)
	const { permissions: _dropped, ...rest } = creation
	expect(await echoed(response)).toEqual({ ...rest, agent: 'limitless' })
	expect(received[0]).toMatchObject({ url: '/api/agent', directory: '/work tree/日本語' })
})

test('a location without a selectable default agent fails visibly', async () => {
	const { call } = await fixture([{ id: 'research', mode: 'subagent', hidden: false }])
	const response = await call('POST', '/api/session', { ...creation, agent: 'build' })
	expect(response.status).toBe(502)
	expect(await response.text()).toBe('Unable to resolve the default OpenCode agent')
})

test('switching to build selects the default; other switches pass through', async () => {
	const { received, call } = await fixture()
	const toBuild = await call('POST', '/api/session/ses_existing/agent', { agent: 'build' })
	expect(await echoed(toBuild)).toEqual({ agent: 'limitless' })
	const toUnit = await call('POST', '/api/session/ses_existing/agent', { agent: 'unit' })
	expect(await echoed(toUnit)).toEqual({ agent: 'unit' })
	expect(received.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
		'GET /api/session/ses_existing',
		'GET /api/agent',
		'POST /api/session/ses_existing/agent',
		'POST /api/session/ses_existing/agent',
	])
})

test('per-agent MCP registration is refused before reaching the service', async () => {
	const { received, call } = await fixture()
	const response = await call('PUT', '/api/experimental/mcp/custom', { config: {} })
	expect(response.status).toBe(501)
	expect(await response.text()).toContain('does not support per-agent MCP servers')
	expect(received).toEqual([])
	const listing = await call('GET', '/api/mcp')
	expect(listing.status).toBe(200)
})

test('instructions and session environments pass through unchanged', async () => {
	const { received, call } = await fixture()
	await call('PUT', '/api/experimental/session/ses_existing/instructions/entries/paseo', {
		value: 'Paseo system prompt',
	})
	await call('PUT', '/api/session/ses_existing/environment', {
		variables: { PASEO_AGENT_ID: 'a1' },
	})
	expect(received.map((entry) => JSON.parse(entry.body))).toEqual([
		{ value: 'Paseo system prompt' },
		{ variables: { PASEO_AGENT_ID: 'a1' } },
	])
})
