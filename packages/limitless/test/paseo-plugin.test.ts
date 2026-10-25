import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DateTime, Effect, Exit, Scope } from 'effect'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import plugin, { boundExecutionsKey, restoreServiceEnvironment } from '../paseo/plugin'

// The real `paseo` plugin against a minimal host: per-Location hook and tool
// registries, sessions' idle times, and a fake Paseo tool bridge behind fetch.

type Hook = (input: unknown) => Effect.Effect<void>
type Tool = { name: string }
type Context = {
	sessionID: string
	tools: Record<string, unknown>
	system: Array<{ type: string; text: string }>
}

let runtime: string
const scopes: Scope.Closeable[] = []
const bindings = new Map<string, string[]>()
const parents = new Map<string, string>()
/** When each session last went idle, as OpenCode records it. */
const idles = new Map<string, number>()

beforeEach(async () => {
	runtime = await mkdtemp(join(tmpdir(), 'limitless-paseo-plugin-'))
	vi.stubEnv('XDG_RUNTIME_DIR', runtime)
	vi.stubGlobal('fetch', async (url: URL | string) => {
		const match = /\/sessions\/([^/]+)\/context/.exec(String(url))
		const tools = match?.[1] === undefined ? undefined : bindings.get(decodeURIComponent(match[1]))
		return tools === undefined
			? Response.json({ error: 'not bound' }, { status: 404 })
			: Response.json({ env: {}, tools })
	})
})

afterEach(async () => {
	for (const scope of scopes.splice(0))
		await Effect.runPromise(Scope.close(scope, Exit.void))
		// The plugin's execution records are process-wide by design.
	;(globalThis as unknown as Record<symbol, Map<string, unknown> | undefined>)[
		boundExecutionsKey
	]?.clear()
	bindings.clear()
	parents.clear()
	idles.clear()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

async function register(token: string, tools = ['list_agents', 'create_agent']) {
	await mkdir(join(runtime, 'limitless'), { recursive: true })
	const temporary = join(runtime, 'limitless', `${token}.tmp`)
	await writeFile(
		temporary,
		JSON.stringify({
			v: 1,
			baseUrl: 'http://127.0.0.1:9',
			token,
			tools: tools.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })),
		}),
	)
	await rename(temporary, join(runtime, 'limitless', 'paseo-tool-bridge.json'))
}

async function until(condition: () => boolean, what: string) {
	for (
		const deadline = Date.now() + 3000;
		!condition();
		await new Promise((done) => setTimeout(done, 10))
	)
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
}

/** One Location's instance of the plugin. */
async function location() {
	const hooks = new Map<string, Hook>()
	const tools: Record<string, Tool> = {}
	let transform: ((editor: { add(tool: Tool): void }) => void) | undefined
	let reloads = 0
	const interrupts: string[] = []
	const replay = () => {
		for (const name of Object.keys(tools)) delete tools[name]
		transform?.({ add: (tool) => (tools[tool.name] = tool) })
	}
	const registration = { dispose: Effect.void }
	const ctx = {
		shell: {
			hook: (name: string, callback: Hook) =>
				Effect.sync(() => hooks.set(`shell.${name}`, callback)).pipe(Effect.as(registration)),
		},
		session: {
			hook: (name: string, callback: Hook) =>
				Effect.sync(() => hooks.set(name, callback)).pipe(Effect.as(registration)),
			get: ({ sessionID }: { sessionID: string }) => {
				const idle = idles.get(sessionID)
				return Effect.succeed({
					parentID: parents.get(sessionID),
					time: { idle: idle === undefined ? undefined : DateTime.makeUnsafe(idle) },
				})
			},
			interrupt: ({ sessionID }: { sessionID: string }) =>
				Effect.sync(() => {
					interrupts.push(sessionID)
					return { interrupted: true }
				}),
		},
		tool: {
			transform: (callback: typeof transform) =>
				Effect.sync(() => {
					transform = callback
					replay()
				}).pipe(Effect.as(registration)),
			reload: () =>
				Effect.sync(() => {
					reloads++
					replay()
				}),
		},
	}
	const scope = await Effect.runPromise(Scope.make())
	scopes.push(scope)
	const unload = () => Effect.runPromise(Scope.close(scope, Exit.void))
	await Effect.runPromise(
		// biome-ignore lint/suspicious/noExplicitAny: a minimal host stands in for OpenCode's plugin context.
		plugin.effect(ctx as any).pipe(Effect.provideService(Scope.Scope, scope)),
	)
	const hook = (name: string, input: unknown) => {
		const callback = hooks.get(name)
		if (callback === undefined) throw new Error(`Missing ${name} hook`)
		return Effect.runPromise(callback(input))
	}
	return {
		tools,
		interrupts,
		unload,
		reloads: () => reloads,
		prompt: (sessionID: string) => hook('prompt', { sessionID }),
		/** One agent step: the tools offered, as filtered for this session. */
		step: async (sessionID: string) => {
			const input: Context = { sessionID, tools: { ...tools }, system: [] }
			await hook('context', input)
			await new Promise((done) => setTimeout(done, 10))
			return input
		},
	}
}

test('stays inert without a registration', async () => {
	const host = await location()
	const step = await host.step('ses_tui')
	expect(Object.keys(step.tools)).toEqual([])
	expect(step.system).toEqual([])
})

test('a prompt picks up a new registration before its first step; bindings scope the tools', async () => {
	const host = await location()
	await register('token-1')
	await host.prompt('ses_agent')
	bindings.set('ses_agent', ['list_agents'])
	const bound = await host.step('ses_agent')
	expect(Object.keys(bound.tools)).toEqual(['paseo_list_agents'])
	expect(bound.system.map((part) => part.text).join()).toContain('## Paseo integration')
	const tui = await host.step('ses_tui')
	expect(Object.keys(tui.tools)).toEqual([])
	expect(tui.system).toEqual([])
	parents.set('ses_child', 'ses_agent')
	expect(Object.keys((await host.step('ses_child')).tools)).toEqual(['paseo_list_agents'])
})

test('a Location loaded earlier picks up the registration without a prompt', async () => {
	const host = await location()
	await register('token-1')
	await until(
		() => host.reloads() > 0 && 'paseo_list_agents' in host.tools,
		'the watched registration',
	)
	bindings.set('ses_moved', ['list_agents'])
	expect(Object.keys((await host.step('ses_moved')).tools)).toEqual(['paseo_list_agents'])
})

test('an execution whose binding closes is interrupted, even after moving Locations or a steer', async () => {
	await register('token-1')
	const first = await location()
	const second = await location()
	bindings.set('ses_agent', ['list_agents'])
	await first.prompt('ses_agent')
	await first.step('ses_agent')
	await second.prompt('ses_agent') // A steer during the execution starts no new execution.
	bindings.delete('ses_agent')
	const closed = await second.step('ses_agent')
	expect(Object.keys(closed.tools)).toEqual([])
	await until(() => second.interrupts.includes('ses_agent'), 'the interruption')
	// The record ends with the interruption: later steps are not interrupted again.
	await second.step('ses_agent')
	expect(second.interrupts).toEqual(['ses_agent'])
})

test('an ended execution is not interrupted by a later prompt after its binding closes', async () => {
	await register('token-1')
	const host = await location()
	bindings.set('ses_agent', ['list_agents'])
	await host.step('ses_agent')
	idles.set('ses_agent', Date.now()) // The execution ends.
	bindings.delete('ses_agent')
	await host.prompt('ses_agent')
	await host.step('ses_agent')
	await new Promise((done) => setTimeout(done, 20))
	expect(host.interrupts).toEqual([])
})

test('an execution that ends while no instance is loaded is not interrupted later', async () => {
	await register('token-1')
	const first = await location()
	bindings.set('ses_agent', ['list_agents'])
	await first.step('ses_agent')
	// The plugin unloads, so nothing observes the execution ending.
	await first.unload()
	idles.set('ses_agent', Date.now())
	const second = await location()
	bindings.delete('ses_agent')
	await second.prompt('ses_agent')
	await second.step('ses_agent')
	await new Promise((done) => setTimeout(done, 20))
	expect(second.interrupts).toEqual([])
})

test('a restarted Paseo daemon that has not rebound a session does not interrupt it', async () => {
	await register('token-1')
	const host = await location()
	bindings.set('ses_agent', ['list_agents'])
	await host.step('ses_agent')
	bindings.delete('ses_agent')
	await register('token-2')
	await host.prompt('ses_other')
	await host.step('ses_agent')
	await new Promise((done) => setTimeout(done, 20))
	expect(host.interrupts).toEqual([])
})

test('concurrent prompts reload the tools once per registration change', async () => {
	const host = await location()
	await register('token-1')
	await Promise.all(Array.from({ length: 50 }, (_, index) => host.prompt(`ses_${index}`)))
	await new Promise((done) => setTimeout(done, 50))
	expect(host.reloads()).toBe(1)
})

test('Paseo shells keep the service environment plus Paseo’s own variables', () => {
	const service = { PATH: '/run/wrappers/bin:/rg/bin', HOME: '/home/user', SECRET_TOKEN: 'service' }
	const paseoShell = {
		env: {
			PATH: '/paseo/bin',
			HOME: '/home/user',
			PASEO_AGENT_ID: 'agent-1',
			PASEO_AGENT_CWD: '/work',
			PASEO_HOME: '/home/user/.paseo',
			NODE_ENV: 'production',
			TERM: 'xterm-256color',
			OPENCODE_TERMINAL: '1',
		} as Record<string, string | undefined>,
	}
	restoreServiceEnvironment(paseoShell, service)
	expect(paseoShell.env).toEqual({
		...service,
		PASEO_AGENT_ID: 'agent-1',
		PASEO_AGENT_CWD: '/work',
		PASEO_HOME: '/home/user/.paseo',
		TERM: 'xterm-256color',
		OPENCODE_TERMINAL: '1',
	})
	const nativeShell = { env: { PATH: '/session/bin' } as Record<string, string | undefined> }
	restoreServiceEnvironment(nativeShell, service)
	expect(nativeShell.env).toEqual({ PATH: '/session/bin' })
})
