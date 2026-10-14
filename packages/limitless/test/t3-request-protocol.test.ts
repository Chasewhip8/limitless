import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AbsolutePath, Location, Model, OpenCode, Provider } from '@opencode/client/effect'
import { Effect } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { afterEach, expect, test } from 'vitest'
import { startT3Bridge } from '../t3/bridge'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close()
})

const authorization = `Basic ${Buffer.from('opencode:fixture').toString('base64')}`
const location = Location.PublicRef.make({ directory: AbsolutePath.make('/fixture/Onboarding') })
const model = Model.Ref.make({
	providerID: Provider.ID.make('openai'),
	id: Model.ID.make('fixture-model'),
})
const namespace = 't3-code-fixture'
const permissions = [
	{ action: '*', resource: '*', effect: 'allow' },
	{ action: 't3-code-*', resource: '*', effect: 'deny' },
	{ action: `${namespace}_*`, resource: '*', effect: 'allow' },
] as const

function json(response: ServerResponse, value: unknown) {
	response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = []
	for await (const chunk of request) chunks.push(Buffer.from(chunk))
	return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
	const backend = createServer(handler)
	backend.listen(0, '127.0.0.1')
	await once(backend, 'listening')
	const address = backend.address()
	if (address === null || typeof address === 'string') throw new Error('Missing fixture address')
	cleanup.push(
		() =>
			new Promise<void>((resolve, reject) => {
				backend.close((error) => (error ? reject(error) : resolve()))
				backend.closeAllConnections()
			}),
	)
	const bridge = await startT3Bridge({
		backend: async () => ({ url: new URL(`http://127.0.0.1:${address.port}`), headers: {} }),
		password: 'fixture',
	})
	cleanup.push(bridge.close)
	return bridge
}

test('accepts omitted create fields encoded as null by the actual OpenCode Effect client', async () => {
	let calls = 0
	let forwardedBody: unknown
	const bridge = await fixture((request, response) => {
		calls++
		void (async () => {
			forwardedBody = await jsonBody(request)
			json(response, {
				data: {
					id: 'ses_fixture',
					projectID: 'fixture',
					location,
					model,
					cost: 0,
					tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
					time: { created: 0, updated: 0 },
				},
			})
		})()
	})
	const created = await Effect.runPromise(
		Effect.gen(function* () {
			const base = yield* HttpClient.HttpClient
			const client = yield* OpenCode.make({ baseUrl: bridge.url }).pipe(
				Effect.provideService(
					HttpClient.HttpClient,
					HttpClient.mapRequest(base, HttpClientRequest.setHeader('authorization', authorization)),
				),
			)
			return yield* client.session.create({ location, model, permissions, title: 'Fixture thread' })
		}).pipe(Effect.provide(FetchHttpClient.layer)),
	)
	expect(created.id).toBe('ses_fixture')
	expect(calls).toBe(1)
	expect(forwardedBody).toMatchObject({
		agent: null,
		permissions: expect.arrayContaining([
			{ action: 't3-code-*', resource: '*', effect: 'deny' },
			{ action: `${namespace}_*`, resource: '*', effect: 'allow' },
			{ action: `${namespace}_delegate_task`, resource: '*', effect: 'deny' },
		]),
	})
	expect(forwardedBody).not.toMatchObject({
		permissions: expect.arrayContaining([{ action: '*', resource: '*', effect: 'allow' }]),
	})
})

test('ignores null no-op update fields when coordinating a permission-only PATCH', async () => {
	const paths: string[] = []
	const bridge = await fixture((request, response) => {
		paths.push(`${request.method} ${request.url}`)
		request.resume()
		if (request.method === 'GET') {
			json(response, { data: { id: 'ses_fixture', location } })
			return
		}
		json(response, { output: null })
	})
	const response = await fetch(`${bridge.url}/api/session/ses_fixture`, {
		method: 'PATCH',
		headers: { authorization, 'content-type': 'application/json' },
		body: JSON.stringify({ title: null, metadata: null, permissions }),
	})
	expect(response.status).toBe(204)
	expect(paths).toEqual([
		'GET /api/session/ses_fixture',
		'POST /api/rpc/limitless.t3/updatePermissions',
	])
})

test('forwards title-only updates whose unused permissions field is encoded as null', async () => {
	const paths: string[] = []
	const bridge = await fixture((request, response) => {
		paths.push(`${request.method} ${request.url}`)
		request.resume()
		response.writeHead(204).end()
	})
	const response = await fetch(`${bridge.url}/api/session/ses_fixture`, {
		method: 'PATCH',
		headers: { authorization, 'content-type': 'application/json' },
		body: JSON.stringify({ title: 'New title', metadata: null, permissions: null }),
	})
	expect(response.status).toBe(204)
	expect(paths).toEqual(['PATCH /api/session/ses_fixture'])
})

test('still rejects invalid agents and permission changes mixed with effective title updates', async () => {
	let calls = 0
	const bridge = await fixture((request, response) => {
		calls++
		request.resume()
		response.writeHead(204).end()
	})
	for (const [method, path, body] of [
		['POST', '/api/session', { agent: 1, permissions }],
		['PATCH', '/api/session/ses_fixture', { title: 'Changed', metadata: null, permissions }],
	] as const) {
		const response = await fetch(`${bridge.url}${path}`, {
			method,
			headers: { authorization, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})
		expect(response.status).toBe(400)
	}
	expect(calls).toBe(0)
})
