import { once } from 'node:events'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Exit } from 'effect'
import { afterEach, expect, test } from 'vitest'
import {
	readRegistration,
	registerToolBridge,
	registrationPath,
	registrationStamp,
	toolBridgeFromLaunchConfig,
} from '../paseo/registration'
import { isLoopbackToolBridge } from '../paseo/tool-bridge'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close()
})

const paseoPlugin = (options: Record<string, unknown>) => ({
	package: 'file:///home/user/.paseo/runtime/opencode/paseo-v2-0123abcd',
	options,
})
const launchConfig = (...plugins: unknown[]) =>
	JSON.stringify({ plugins: ['file:///nix/store/limitless', ...plugins] })

test('finds Paseo’s tool bridge among the launch configuration’s plugins', async () => {
	const bridge = await Effect.runPromise(
		toolBridgeFromLaunchConfig(
			launchConfig(paseoPlugin({ baseUrl: 'http://127.0.0.1:41234', token: 'abc' })),
		),
	)
	expect(bridge).toEqual({ baseUrl: 'http://127.0.0.1:41234', token: 'abc' })
})

test.each([
	['no configuration', undefined],
	['malformed JSON', '{plugins'],
	['no Paseo plugin', launchConfig()],
	[
		'a lookalike package outside Paseo’s runtime',
		launchConfig({
			package: 'file:///tmp/other',
			options: { baseUrl: 'http://127.0.0.1:1', token: 'x' },
		}),
	],
	[
		'a remote bridge',
		launchConfig(paseoPlugin({ baseUrl: 'http://example.com:80', token: 'abc' })),
	],
	['an empty token', launchConfig(paseoPlugin({ baseUrl: 'http://127.0.0.1:1', token: '' }))],
	[
		'two bridges',
		launchConfig(paseoPlugin({ baseUrl: 'http://127.0.0.1:1', token: 'a' }), {
			...paseoPlugin({ baseUrl: 'http://127.0.0.1:2', token: 'b' }),
			package: 'file:///x/paseo-v2-ff',
		}),
	],
])('rejects %s', async (_case, content) => {
	const exit = await Effect.runPromiseExit(toolBridgeFromLaunchConfig(content))
	expect(Exit.isFailure(exit)).toBe(true)
})

test('only plain loopback HTTP tool bridges are trusted with the token', () => {
	expect(isLoopbackToolBridge('http://127.0.0.1:6767')).toBe(true)
	expect(isLoopbackToolBridge('http://[::1]:6767')).toBe(true)
	expect(isLoopbackToolBridge('https://127.0.0.1:6767')).toBe(false)
	expect(isLoopbackToolBridge('http://user:pw@127.0.0.1:6767')).toBe(false)
	expect(isLoopbackToolBridge('http://127.0.0.1.example.com')).toBe(false)
	expect(isLoopbackToolBridge('not a url')).toBe(false)
})

test('the registration lives in the user runtime directory, which must be absolute', async () => {
	expect(await Effect.runPromise(registrationPath({ XDG_RUNTIME_DIR: '/run/user/1000' }))).toBe(
		'/run/user/1000/limitless/paseo-tool-bridge.json',
	)
	expect(Exit.isFailure(await Effect.runPromiseExit(registrationPath({})))).toBe(true)
	expect(
		Exit.isFailure(await Effect.runPromiseExit(registrationPath({ XDG_RUNTIME_DIR: 'relative' }))),
	).toBe(true)
})

/** A Paseo tool bridge serving a manifest; `stop` makes it unreachable. */
async function toolBridge(token: string, tools = ['list_agents']) {
	const server: Server = createServer((request, response) => {
		if (request.headers.authorization !== `Bearer ${token}`)
			return response.writeHead(401).end('{}')
		response.writeHead(200, { 'content-type': 'application/json' }).end(
			JSON.stringify({
				tools: tools.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })),
			}),
		)
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const address = server.address()
	if (address === null || typeof address === 'string') throw new Error('Missing fixture address')
	const stop = () =>
		new Promise<void>((resolve) => {
			if (!server.listening) return resolve()
			server.close(() => resolve())
			server.closeAllConnections()
		})
	cleanup.push(stop)
	return { baseUrl: `http://127.0.0.1:${address.port}`, token, stop }
}

async function runtime() {
	const directory = await mkdtemp(join(tmpdir(), 'limitless-paseo-'))
	const path = join(directory, 'limitless', 'paseo-tool-bridge.json')
	const environment = (bridge: { baseUrl: string; token: string }) => ({
		XDG_RUNTIME_DIR: directory,
		OPENCODE_CONFIG_CONTENT: launchConfig(
			paseoPlugin({ baseUrl: bridge.baseUrl, token: bridge.token }),
		),
	})
	const register = (bridge: { baseUrl: string; token: string }) =>
		Effect.runPromiseExit(registerToolBridge(environment(bridge)))
	return { directory, path, register }
}

test('registers privately and leaves an unchanged registration untouched', async () => {
	const { directory, path, register } = await runtime()
	const bridge = await toolBridge('first')
	expect(Exit.isSuccess(await register(bridge))).toBe(true)
	expect((await stat(path)).mode & 0o777).toBe(0o600)
	expect((await stat(join(directory, 'limitless'))).mode & 0o777).toBe(0o700)
	const first = await Effect.runPromise(readRegistration(path))
	expect(first.registration).toEqual({
		v: 1,
		baseUrl: bridge.baseUrl,
		token: 'first',
		tools: [{ name: 'list_agents', description: 'list_agents', inputSchema: { type: 'object' } }],
	})
	// Paseo launches a server for many requests; the plugin must not reload for each.
	expect(Exit.isSuccess(await register(bridge))).toBe(true)
	expect(await Effect.runPromise(registrationStamp(path))).toBe(first.stamp)
})

test('another live daemon keeps its registration; a dead one is replaced', async () => {
	const { path, register } = await runtime()
	const owner = await toolBridge('owner')
	const intruder = await toolBridge('intruder')
	expect(Exit.isSuccess(await register(owner))).toBe(true)
	const refused = await register(intruder)
	expect(Exit.isFailure(refused) && JSON.stringify(refused.cause)).toContain('Another Paseo daemon')
	await owner.stop()
	expect(Exit.isSuccess(await register(intruder))).toBe(true)
	expect(JSON.parse(await readFile(path, 'utf8')).token).toBe('intruder')
})

test('an invalid or foreign registration is reported rather than trusted', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'limitless-paseo-'))
	const path = join(directory, 'paseo-tool-bridge.json')
	await writeFile(path, '{"v":1}')
	expect(Exit.isFailure(await Effect.runPromiseExit(readRegistration(path)))).toBe(true)
	await writeFile(
		path,
		JSON.stringify({ v: 1, baseUrl: 'http://example.com', token: 't', tools: [] }),
	)
	expect(Exit.isFailure(await Effect.runPromiseExit(readRegistration(path)))).toBe(true)
})
