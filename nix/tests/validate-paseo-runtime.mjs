import assert from 'node:assert/strict'
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Run with Bun: <limitless-package> <opencode-binary> <expected-version>.
// Real OpenCode with the limitless and paseo plugins, a scripted model provider,
// and a fake Paseo daemon bridge that answers Paseo's internal protocol.
const [bundleDirectory, executable, expectedVersion] = process.argv.slice(2)
assert(
	bundleDirectory && executable && expectedVersion,
	'Pass <limitless-package> <opencode-binary> <expected-version>',
)
const { registerPaseoToolBridge, startPaseoBridge } = await import(
	pathToFileURL(join(resolve(bundleDirectory), 'paseo.js')).href
)

const temporary = process.env.TMPDIR ?? '/tmp/opencode'
mkdirSync(temporary, { recursive: true })
const directory = mkdtempSync(join(temporary, 'limitless-paseo-runtime-'))
for (const name of ['workspace', 'home', 'config', 'data', 'state', 'cache', 'runtime', 'identity'])
	mkdirSync(join(directory, name))
const workspace = join(directory, 'workspace')
const runtime = join(directory, 'runtime')
const report = { directory, checks: [], status: 'RUNNING' }
const check = (name, details = {}) => report.checks.push({ name, ...details })
const rule = (action, effect, resource = '*') => ({ action, resource, effect })
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const deferred = () => {
	let resolve
	const promise = new Promise((done) => {
		resolve = done
	})
	return { promise, resolve }
}

// ---------------------------------------------------------------- model provider

const requests = []
const requestWaiters = new Map()
const phases = new Map()
const awaitRequest = (tag, phase = 1) => {
	const found = requests.find((entry) => entry.tag === tag && entry.phase === phase)
	if (found) return Promise.resolve(found)
	const key = `${tag}#${phase}`
	if (!requestWaiters.has(key)) requestWaiters.set(key, deferred())
	return requestWaiters.get(key).promise
}
const toolCall = (name, input) => ({
	tool_calls: [
		{
			index: 0,
			id: `call_${crypto.randomUUID()}`,
			type: 'function',
			function: { name, arguments: JSON.stringify(input) },
		},
	],
})
const provider = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	idleTimeout: 0,
	async fetch(request) {
		const body = await request.json()
		const kind = request.headers.get('x-test-kind')
		const sent = JSON.stringify(body.messages ?? [])
		const line = (body.messages ?? [])
			.filter((message) => message.role === 'user')
			.flatMap((message) =>
				(typeof message.content === 'string'
					? message.content
					: JSON.stringify(message.content)
				).split('\n'),
			)
			.filter((text) => text.startsWith('DIAG:'))
			.at(-1)
		const command = kind === 'primary' && line ? JSON.parse(line.slice(5)) : undefined
		const sessionID = request.headers.get('x-test-session')
		const key = `${sessionID}/${command?.tag}`
		const phase = (phases.get(key) ?? 0) + 1
		phases.set(key, phase)
		const record = {
			sessionID,
			agent: request.headers.get('x-test-agent'),
			kind,
			tag: command?.tag,
			phase,
			tools: (body.tools ?? []).map((entry) => entry.function.name),
			sent,
			aborted: false,
		}
		requests.push(record)
		appendFileSync(
			join(directory, 'provider-requests.jsonl'),
			`${JSON.stringify({ ...record, sent: undefined })}\n`,
		)
		requestWaiters.get(`${command?.tag}#${phase}`)?.resolve(record)
		let delta = { content: 'DONE' }
		if (command?.kind === 'call' && phase === 1) delta = toolCall(command.tool, command.input)
		if (command?.kind === 'invoke' && phase === 1)
			delta = toolCall('subagent', {
				agent: command.agent,
				description: 'Paseo runtime fixture',
				prompt: `DIAG:${JSON.stringify(command.child)}`,
			})
		if (command?.kind === 'hold' && phase === 1) delta = toolCall('shell', { command: 'sleep 2' })
		if (command?.kind === 'hold' && phase >= 2) {
			// Never released: only an interruption ends this run.
			await new Promise((done) => {
				request.signal.addEventListener('abort', done)
				setTimeout(done, 60000)
			})
			record.aborted = request.signal.aborted
		}
		const chunk = (value, finish_reason = null) => ({
			id: 'chatcmpl_fixture',
			object: 'chat.completion.chunk',
			created: 1,
			model: 'fixture',
			choices: [{ index: 0, delta: value, finish_reason }],
		})
		return new Response(
			`${[chunk({ role: 'assistant' }), chunk(delta), chunk({}, delta.tool_calls ? 'tool_calls' : 'stop')].map((value) => `data: ${JSON.stringify(value)}\n\n`).join('')}data: [DONE]\n\n`,
			{ headers: { 'content-type': 'text/event-stream' } },
		)
	},
})

// ------------------------------------------------------------ fake Paseo bridge

const pixel =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const manifest = [
	'list_agents',
	'create_agent',
	'send_agent_prompt',
	'browser_snapshot',
	'image_probe',
	'failing_probe',
].map((name) => ({
	name,
	description: `Paseo runtime fixture: ${name}`,
	inputSchema: { type: 'object', properties: { marker: { type: 'string' } } },
}))
const allTools = manifest.map((tool) => tool.name)
const bindings = new Map()
const toolCalls = []
const json = (value, status = 200) =>
	new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
function paseoBridge(token, { hangBindings = false } = {}) {
	return Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			if (request.headers.get('authorization') !== `Bearer ${token}`)
				return json({ error: 'Unauthorized' }, 401)
			const url = new URL(request.url)
			if (url.pathname === '/_internal/opencode/tools') return json({ tools: manifest })
			const context = /^\/_internal\/opencode\/sessions\/([^/]+)\/context$/.exec(url.pathname)
			if (context) {
				if (hangBindings) await new Promise(() => {})
				const tools = bindings.get(decodeURIComponent(context[1]))
				if (!tools) return json({ error: 'OpenCode session is not bound to a Paseo agent' }, 404)
				return json({ env: {}, ...(url.searchParams.has('tools') ? { tools } : {}) })
			}
			const call = /^\/_internal\/opencode\/sessions\/([^/]+)\/tools\/([^/]+)$/.exec(url.pathname)
			if (call && request.method === 'POST') {
				const sessionID = decodeURIComponent(call[1])
				const name = decodeURIComponent(call[2])
				const input = await request.json()
				toolCalls.push({ sessionID, name, input })
				if (!bindings.get(sessionID)?.includes(name))
					return json({ error: `Paseo tool not found: ${name}` }, 404)
				if (name === 'image_probe')
					return json({ content: [{ type: 'image', data: pixel, mimeType: 'image/png' }] })
				if (name === 'failing_probe')
					return json({ content: [{ type: 'text', text: 'PROBE_FAILED' }], isError: true })
				return json({ content: [{ type: 'text', text: `PASEO_RESULT:${name}:${input.marker}` }] })
			}
			return json({ error: 'Not found' }, 404)
		},
	})
}
const launchEnvironment = (bridge, token) => ({
	XDG_RUNTIME_DIR: runtime,
	OPENCODE_CONFIG_CONTENT: JSON.stringify({
		plugins: [
			{
				package: `file://${directory}/paseo-home/runtime/opencode/paseo-v2-fixture`,
				options: { baseUrl: bridge.url.origin, token },
			},
		],
	}),
})

// --------------------------------------------------------------------- OpenCode

writeFileSync(join(directory, 'identity', 'package.json'), JSON.stringify({ type: 'module' }))
writeFileSync(
	join(directory, 'identity', 'index.js'),
	`export default {id:'runtime-fixture-identity',async setup(ctx){await ctx.session.hook('model.request',async event=>{const session=await ctx.session.get({sessionID:event.sessionID});event.headers['x-test-session']=event.sessionID;event.headers['x-test-agent']=session.agent??'limitless';event.headers['x-test-kind']=event.kind})}}`,
)
const configuration = {
	default_agent: 'limitless',
	model: 'fixture/fixture',
	experimental: { subagent_depth: 2 },
	permissions: [rule('*', 'allow')],
	plugins: [
		'-opencode.browser',
		resolve(bundleDirectory),
		join(resolve(bundleDirectory), 'paseo'),
		join(directory, 'identity'),
	],
	providers: {
		fixture: {
			package: '@opencode/ai/providers/openai-compatible',
			env: [],
			settings: { baseURL: `${provider.url}v1`, apiKey: 'fixture', transport: 'http' },
			models: {
				fixture: {
					limit: { context: 1000000, output: 16000 },
					capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
				},
			},
		},
	},
	agents: {
		limitless: {
			mode: 'primary',
			description: 'Fixture',
			model: 'fixture/fixture',
			permissions: [],
		},
		unit: {
			mode: 'subagent',
			description: 'Fixture',
			model: 'fixture/fixture',
			permissions: [rule('paseo_*', 'deny')],
		},
		research: {
			mode: 'subagent',
			description: 'Fixture',
			model: 'fixture/fixture',
			permissions: [rule('question', 'deny'), rule('subagent', 'deny'), rule('paseo_*', 'deny')],
		},
	},
}
const configFile = join(directory, 'opencode.json')
writeFileSync(configFile, JSON.stringify(configuration, null, 2))
const opencode = Bun.spawn(
	[resolve(executable), 'serve', '--hostname', '127.0.0.1', '--port', '0', '--log-level', 'debug'],
	{
		cwd: workspace,
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			PATH: process.env.PATH,
			HOME: join(directory, 'home'),
			XDG_CONFIG_HOME: join(directory, 'config'),
			XDG_DATA_HOME: join(directory, 'data'),
			XDG_STATE_HOME: join(directory, 'state'),
			XDG_CACHE_HOME: join(directory, 'cache'),
			XDG_RUNTIME_DIR: runtime,
			OPENCODE_CONFIG_DIR: join(directory, 'config', 'opencode'),
			OPENCODE_CONFIG: configFile,
			OPENCODE_CONFIG_PROJECT_DISABLE: '1',
			OPENCODE_DISABLE_MODELS_FETCH: '1',
			OPENCODE_DISABLE_FILEWATCHER: '1',
			OPENCODE_DISABLE_FFF: '1',
			OPENCODE_DISABLE_CLAUDE_CODE: '1',
			OPENCODE_PASSWORD: 'isolated-backend',
			LIMITLESS_SERVICE_MARKER: 'service',
		},
	},
)
const listening = deferred()
const stdoutTask = (async () => {
	let output = ''
	for await (const bytes of opencode.stdout) {
		const text = new TextDecoder().decode(bytes)
		appendFileSync(join(directory, 'stdout.log'), text)
		output += text
		const match = /server listening on (http:\/\/\S+)/.exec(output)
		if (match) listening.resolve(match[1])
	}
})()
const stderrTask = (async () => {
	for await (const bytes of opencode.stderr)
		appendFileSync(join(directory, 'stderr.log'), new TextDecoder().decode(bytes))
})()

const backendAuth = `Basic ${Buffer.from('opencode:isolated-backend').toString('base64')}`
const bridgeAuth = `Basic ${Buffer.from('opencode:isolated-paseo').toString('base64')}`
let backend
let bridge

async function raw(base, method, path, body) {
	const response = await fetch(new URL(path, base), {
		method,
		headers: {
			authorization: base === backend ? backendAuth : bridgeAuth,
			'content-type': 'application/json',
			'x-opencode-directory': encodeURIComponent(workspace),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(60000),
	})
	const text = await response.text()
	return {
		status: response.status,
		text,
		body:
			response.headers.get('content-type')?.includes('json') && text ? JSON.parse(text) : undefined,
	}
}
async function api(method, path, body, base = backend) {
	const result = await raw(base, method, path, body)
	assert(
		result.status >= 200 && result.status < 300,
		`${method} ${path}: ${result.status} ${result.text}`,
	)
	return result.body
}
const create = async (base, body) =>
	(
		await api(
			'POST',
			'/api/session',
			{
				id: null,
				metadata: null,
				title: 'Paseo runtime fixture',
				location: { directory: workspace },
				...body,
			},
			base,
		)
	).data
async function prompt(id, command, wait = true) {
	await api('POST', `/api/session/${id}/prompt`, { text: `DIAG:${JSON.stringify(command)}` })
	if (wait) await api('POST', `/api/experimental/session/${id}/wait`)
}
// The plugin logs each interruption it requests to OpenCode's server log.
const interruptionsLogged = (sessionID) => {
	const logs = join(directory, 'data', 'opencode', 'log')
	if (!existsSync(logs)) return 0
	return (
		readdirSync(logs)
			.map((name) => readFileSync(join(logs, name), 'utf8'))
			.join('\n')
			.split(`[paseo] interrupting ${sessionID}:`).length - 1
	)
}
const paseoTools = (record) => record.tools.filter((name) => name.startsWith('paseo_')).sort()
const guidanceCount = (record) => record.sent.split('## Paseo integration').length - 1
const snapshot = async (id, tag) => {
	await prompt(id, { kind: 'snapshot', tag })
	return awaitRequest(tag)
}

async function verify() {
	backend = await listening.promise
	assert.equal((await api('GET', '/api/info')).version, expectedVersion)
	bridge = await startPaseoBridge({
		password: 'isolated-paseo',
		backend: async () => ({ url: new URL(backend), headers: { authorization: backendAuth } }),
	})

	// Paseo polls the Location's plugin inventory until it loads, then requires
	// an active plugin with ID `paseo`.
	let plugins = []
	for (const deadline = Date.now() + 30000; plugins.length === 0; await sleep(50)) {
		assert(Date.now() < deadline, 'The plugin inventory never loaded')
		plugins = (await api('GET', '/api/plugin', undefined, bridge.url)).data
	}
	assert(
		plugins.some((entry) => entry.id === 'paseo' && entry.state?.status === 'active'),
		`paseo plugin is not active: ${JSON.stringify(plugins)}`,
	)
	check('readiness')

	// Without a registration the plugin is inert.
	const tui = await create(backend, { agent: null, permissions: [] })
	assert.deepEqual(paseoTools(await snapshot(tui.id, 'unregistered')), [])
	check('unregistered')

	// The launcher records the bridge; a second live daemon cannot take it over.
	const bridgeA = paseoBridge('token-a')
	await registerPaseoToolBridge(launchEnvironment(bridgeA, 'token-a'))
	const registration = join(runtime, 'limitless', 'paseo-tool-bridge.json')
	assert.equal(statSync(registration).mode & 0o777, 0o600)
	const bridgeB = paseoBridge('token-b')
	await assert.rejects(
		registerPaseoToolBridge(launchEnvironment(bridgeB, 'token-b')),
		/Another Paseo daemon/,
	)
	bridgeB.stop(true)
	check('registration')

	// Session creation through the bridge: build becomes the default, Paseo's rules are dropped.
	const paseo = await create(bridge.url, {
		agent: 'build',
		permissions: [rule('*', 'allow')],
	})
	assert.equal(paseo.agent, 'limitless')
	assert(
		!(paseo.permissions ?? []).some((entry) => entry.action === '*' && entry.effect === 'allow'),
	)
	bindings.set(paseo.id, allTools)
	// The first prompt after registration already sees the tools.
	const first = await snapshot(paseo.id, 'paseo-first')
	assert.deepEqual(paseoTools(first), allTools.map((name) => `paseo_${name}`).sort())
	assert.equal(guidanceCount(first), 1, 'Paseo guidance must appear exactly once')
	check('bound-session', { tools: paseoTools(first).length })

	const unbound = await snapshot(tui.id, 'tui')
	assert.deepEqual(paseoTools(unbound), [])
	assert.equal(guidanceCount(unbound), 0)
	check('unbound-session')

	const unit = await create(bridge.url, { agent: 'unit', permissions: [] })
	assert.equal(unit.agent, 'unit')
	bindings.set(unit.id, allTools)
	const unitStep = await snapshot(unit.id, 'unit')
	assert.deepEqual(paseoTools(unitStep), [])
	assert.equal(guidanceCount(unitStep), 0)
	check('unit-without-paseo-tools')

	const limited = await create(bridge.url, { agent: 'build', permissions: [] })
	bindings.set(limited.id, ['list_agents'])
	assert.deepEqual(paseoTools(await snapshot(limited.id, 'limited')), ['paseo_list_agents'])
	check('binding-policy')

	// A finished execution's record no longer matches the session's idle time:
	// once Paseo closes the agent, a later prompt (for example from the TUI) runs
	// without interruption.
	bindings.delete(limited.id)
	const continued = await snapshot(limited.id, 'limited-continued')
	assert.deepEqual(paseoTools(continued), [])
	await api('POST', `/api/experimental/session/${limited.id}/wait`)
	assert.equal(continued.aborted, false)
	// Messages list newest first; each execution ends with its idle outcome.
	const [outcome] = (await api('GET', `/api/session/${limited.id}/message`)).data
	assert.deepEqual([outcome.type, outcome.outcome], ['idle', 'succeeded'])
	check('ended-execution-not-interrupted')

	await prompt(paseo.id, {
		kind: 'invoke',
		tag: 'invoke-research',
		agent: 'research',
		child: { kind: 'snapshot', tag: 'research-child' },
	})
	const child = await awaitRequest('research-child')
	assert.equal(child.agent, 'research')
	assert.deepEqual(paseoTools(child), [])
	assert.equal(guidanceCount(child), 0)
	check('support-child')

	await prompt(paseo.id, {
		kind: 'call',
		tag: 'call-list',
		tool: 'paseo_list_agents',
		input: { marker: 'listed' },
	})
	assert.deepEqual(toolCalls.at(-1), {
		sessionID: paseo.id,
		name: 'list_agents',
		input: { marker: 'listed' },
	})
	assert((await awaitRequest('call-list', 2)).sent.includes('PASEO_RESULT:list_agents:listed'))
	await prompt(paseo.id, { kind: 'call', tag: 'call-image', tool: 'paseo_image_probe', input: {} })
	assert((await awaitRequest('call-image', 2)).sent.includes(pixel.slice(0, 24)))
	await prompt(paseo.id, { kind: 'call', tag: 'call-fail', tool: 'paseo_failing_probe', input: {} })
	assert((await awaitRequest('call-fail', 2)).sent.includes('PROBE_FAILED'))
	check('tool-execution')

	// Paseo replaces the shell environment; shells keep the service's plus PASEO_*.
	await api(
		'PUT',
		`/api/session/${paseo.id}/environment`,
		{
			variables: {
				PATH: process.env.PATH,
				PASEO_AGENT_ID: 'agent-a',
				LIMITLESS_SERVICE_MARKER: 'paseo',
			},
		},
		bridge.url,
	)
	await prompt(paseo.id, {
		kind: 'call',
		tag: 'call-shell',
		tool: 'shell',
		input: {
			command:
				'printf "ENV:%s|%s|%s" "$LIMITLESS_SERVICE_MARKER" "$PASEO_AGENT_ID" "$OPENCODE_SESSION_ID"',
		},
	})
	assert(
		(await awaitRequest('call-shell', 2)).sent.includes(`ENV:service|agent-a|${paseo.id}`),
		'Paseo shells must keep the service environment',
	)
	check('shell-environment')

	const mcp = await raw(bridge.url, 'PUT', '/api/experimental/mcp/custom', { config: {} })
	assert.equal(mcp.status, 501)
	check('custom-mcp-refused')

	// Closing an agent's binding mid-run interrupts the run.
	const closing = await create(bridge.url, { agent: 'build', permissions: [] })
	bindings.set(closing.id, allTools)
	await prompt(closing.id, { kind: 'hold', tag: 'hold' }, false)
	await awaitRequest('hold')
	bindings.delete(closing.id)
	const started = Date.now()
	await api('POST', `/api/experimental/session/${closing.id}/wait`)
	assert(Date.now() - started < 30000, 'A closed agent kept running')
	const second = requests.find((entry) => entry.tag === 'hold' && entry.phase === 2)
	assert(second === undefined || second.aborted, 'The interrupted step must not complete')
	for (const deadline = Date.now() + 5000; interruptionsLogged(closing.id) === 0; await sleep(50))
		assert(Date.now() < deadline, 'The plugin did not log the interruption')
	// The finished execution checked earlier was never interrupted.
	assert.equal(interruptionsLogged(limited.id), 0)
	// A new prompt to the session is not interrupted; it just has no Paseo tools.
	assert.deepEqual(paseoTools(await snapshot(closing.id, 'after-close')), [])
	check('closed-agent-interrupted')

	// An unreachable or stalled daemon removes the tools without stalling OpenCode.
	bridgeA.stop(true)
	let begin = Date.now()
	assert.deepEqual(paseoTools(await snapshot(paseo.id, 'bridge-down')), [])
	assert(Date.now() - begin < 15000)
	const hung = paseoBridge('token-hung', { hangBindings: true })
	await registerPaseoToolBridge(launchEnvironment(hung, 'token-hung'))
	begin = Date.now()
	assert.deepEqual(paseoTools(await snapshot(paseo.id, 'bridge-hung')), [])
	assert(Date.now() - begin < 15000)
	hung.stop(true)
	check('daemon-unavailable')
}

try {
	await verify()
	report.status = 'PASS'
} catch (error) {
	report.status = 'FAIL'
	report.error = error instanceof Error ? error.stack : String(error)
} finally {
	await bridge?.close()
	opencode.kill('SIGTERM')
	await opencode.exited
	provider.stop(true)
	await Promise.all([stdoutTask, stderrTask])
}
console.log(JSON.stringify(report, null, 2))
if (report.status !== 'PASS') process.exit(1)
