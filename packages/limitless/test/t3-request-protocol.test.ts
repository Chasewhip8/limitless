import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AbsolutePath, Agent, Location, OpenCode, Session } from '@opencode/client/effect'
import { Mcp } from '@opencode/schema/mcp'
import { Effect } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http'
import { afterEach, expect, test } from 'vitest'
import { startT3Bridge } from '../t3/bridge'
import { T3_CONTEXT } from '../t3/instructions'
import { canonicalT3Namespace } from '../t3/permissions'

// T3 drives the bridge with OpenCode's own generated Effect client; these checks
// use that client so its wire encoding (null optionals, path escaping) stays covered.

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close()
})

const authorization = `Basic ${Buffer.from('opencode:fixture').toString('base64')}`
const directory = '/fixture/Onboarding'
const sessionID = Session.ID.make('ses_fixture')

type Received = { method: string | undefined; url: string | undefined; body: unknown }

async function fixture(reply: (request: IncomingMessage, response: ServerResponse) => boolean) {
	const received: Received[] = []
	const backend = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = []
			for await (const chunk of request) chunks.push(Buffer.from(chunk))
			const text = Buffer.concat(chunks).toString('utf8')
			received.push({ method: request.method, url: request.url, body: text && JSON.parse(text) })
			if (!reply(request, response)) response.writeHead(204).end()
		})()
	})
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
	const client = <A, E>(
		use: (client: Effect.Success<ReturnType<typeof OpenCode.make>>) => Effect.Effect<A, E>,
	) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const base = yield* HttpClient.HttpClient
				const opencode = yield* OpenCode.make({ baseUrl: bridge.url }).pipe(
					Effect.provideService(
						HttpClient.HttpClient,
						HttpClient.mapRequest(
							base,
							HttpClientRequest.setHeader('authorization', authorization),
						),
					),
				)
				return yield* use(opencode)
			}).pipe(Effect.provide(FetchHttpClient.layer)),
		)
	return { received, client }
}

test('replaces the T3 instruction entry sent by the OpenCode client', async () => {
	const { received, client } = await fixture(() => false)
	await client((opencode) =>
		opencode.session.instructions.entry.put({
			sessionID,
			key: 't3-code',
			value: 'RAW T3 orchestration instructions',
		}),
	)
	expect(received).toEqual([
		{
			method: 'PUT',
			url: `/api/experimental/session/${sessionID}/instructions/entries/t3-code`,
			body: { value: T3_CONTEXT },
		},
	])
})

test('resolves the OpenCode client’s build selection to the configured default', async () => {
	const { received, client } = await fixture((request, response) => {
		if (request.url === '/api/agent') {
			response
				.writeHead(200, { 'content-type': 'application/json' })
				.end(JSON.stringify({ data: [{ id: 'limitless', mode: 'primary', hidden: false }] }))
			return true
		}
		if (request.method === 'GET') {
			response
				.writeHead(200, { 'content-type': 'application/json' })
				.end(JSON.stringify({ data: { id: sessionID, location: { directory }, agent: 'plan' } }))
			return true
		}
		return false
	})
	await client((opencode) =>
		opencode.session.switchAgent({ sessionID, agent: Agent.ID.make('build') }),
	)
	expect(received.at(-1)).toEqual({
		method: 'POST',
		url: `/api/session/${sessionID}/agent`,
		body: { agent: 'limitless' },
	})
})

test('hashes the T3 MCP server name the OpenCode client registers and removes', async () => {
	const { received, client } = await fixture(() => false)
	const server = 't3-code-thread_fork'
	const location = Location.PublicRef.make({ directory: AbsolutePath.make(directory) })
	await client((opencode) =>
		Effect.gen(function* () {
			yield* opencode.mcp.add({
				server,
				location,
				config: new Mcp.RemoteConfig({ type: 'remote', url: 'http://127.0.0.1:1/mcp' }),
			})
			yield* opencode.mcp.remove({ server, location: { directory: AbsolutePath.make(directory) } })
		}),
	)
	const hashed = canonicalT3Namespace(server)
	expect(received.map(({ method, url }) => `${method} ${url?.split('?')[0]}`)).toEqual([
		`PUT /api/experimental/mcp/${hashed}`,
		`DELETE /api/experimental/mcp/${hashed}`,
	])
})
