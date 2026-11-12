import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

// Proves the packaged OpenCode hosts Capsule natively: one shared server registers the `capsule`
// workspace provider and serves the Capsule RPC from its control location. Pipeline's runtime
// check owns dispatch; this check owns the native seams and the upstream patches.
const [opencode, runtimePath, system, mode] = process.argv.slice(2)
assert(opencode && runtimePath && system)
assert(mode === undefined || mode === '--without-namespaces', 'Unknown test mode')
process.umask(0o077)
const execute = promisify(execFile)
const runtime = JSON.parse(await readFile(runtimePath, 'utf8'))
const directory = await realpath(
	await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'opencode-capsule-')),
)
const password = randomUUID()
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
const owner = { namespace: 'fixture', id: 'owner-1' }
const writeMarker = 'OPENCODE_CAPSULE_FIXTURE_WRITE'
const output = []

const paths = {
	home: join(directory, 'home'),
	root: join(directory, 'capsule', 'runtime'),
	checkoutRoot: join(directory, 'capsule', 'checkouts'),
	controlDirectory: join(directory, 'capsule', 'control'),
	// An enrolled control address may be a symlink; the RPC is served at the declared alias.
	controlAlias: join(directory, 'control-alias'),
	controlTarget: join(directory, 'control-target'),
	local: join(directory, 'local-project'),
	formatted: join(directory, 'formatted.log'),
	config: join(directory, 'opencode.json'),
	hostConfig: join(directory, 'capsule-host.json'),
}
const database = join(directory, 'data', 'opencode', 'opencode.db')

// Loopback model: writes the file the prompt names once, then answers in text.
const provider = createHttpServer(async (request, response) => {
	let text = ''
	for await (const chunk of request) text += chunk
	const body = JSON.parse(text)
	const write = body.tools?.find((tool) => tool.function?.name === 'write')
	const prompt = JSON.stringify(body.messages.findLast((message) => message.role === 'user'))
	const target = /WRITE ([\w.-]+)/.exec(prompt)?.[1]
	const written = body.messages.some((message) => message.role === 'tool')
	const delta =
		write && target && !written
			? {
					tool_calls: [
						{
							index: 0,
							id: `call_${randomUUID().replaceAll('-', '')}`,
							type: 'function',
							function: {
								name: 'write',
								arguments: JSON.stringify({ path: target, content: `${writeMarker}\n` }),
							},
						},
					],
				}
			: { content: 'Fixture reply' }
	const chunk = (delta, finish_reason = null) =>
		`data: ${JSON.stringify({
			id: 'chatcmpl_capsule_fixture',
			object: 'chat.completion.chunk',
			created: 1,
			model: 'fixture',
			choices: [{ index: 0, delta, finish_reason }],
		})}\n\n`
	response.writeHead(200, { 'content-type': 'text/event-stream' })
	response.write(chunk({ role: 'assistant' }))
	response.write(chunk(delta))
	response.write(chunk({}, delta.tool_calls ? 'tool_calls' : 'stop'))
	response.end('data: [DONE]\n\n')
})
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve))

const settingsFor = (overrides = {}) => ({
	root: paths.root,
	checkoutRoot: paths.checkoutRoot,
	controlDirectory: paths.controlDirectory,
	runtime,
	...overrides,
})

let server
async function start(capsuleConfig) {
	const child = spawn(opencode, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
		cwd: paths.home,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			PATH: runtime.basePath,
			// The Home Manager wrapper exposes the Capsule shell to host and workspace commands alike.
			SHELL: runtime.shell,
			HOME: paths.home,
			XDG_CONFIG_HOME: join(directory, 'config'),
			XDG_DATA_HOME: join(directory, 'data'),
			XDG_STATE_HOME: join(directory, 'state'),
			XDG_CACHE_HOME: join(directory, 'cache'),
			XDG_RUNTIME_DIR: join(directory, 'run'),
			GIT_CONFIG_NOSYSTEM: '1',
			OPENCODE_CONFIG: paths.config,
			OPENCODE_CONFIG_PROJECT_DISABLE: '1',
			OPENCODE_DISABLE_MODELS_FETCH: '1',
			OPENCODE_DISABLE_FILEWATCHER: '1',
			OPENCODE_DISABLE_FFF: '1',
			OPENCODE_DISABLE_CLAUDE_CODE: '1',
			OPENCODE_PASSWORD: password,
			...(capsuleConfig ? { OPENCODE_CAPSULE_CONFIG: capsuleConfig } : {}),
		},
	})
	let log = ''
	const exited = new Promise((resolve) =>
		child.once('exit', (code, signal) => resolve({ code, signal })),
	)
	const listening = new Promise((resolve) => {
		const read = (chunk) => {
			log += chunk
			const match = /server listening on (http:\/\/127\.0\.0\.1:[0-9]+)/.exec(log)
			if (match) resolve(match[1])
		}
		child.stdout.on('data', read)
		child.stderr.on('data', read)
	})
	const url = await Promise.race([
		listening,
		exited.then(() => undefined),
		delay(30000, undefined, { ref: false }).then(() => assert.fail('OpenCode did not listen')),
	])
	server = {
		child,
		exited,
		url,
		log: () => log,
		stop: async () => {
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
			const result = await Promise.race([exited, delay(10000, null, { ref: false })])
			if (!result) child.kill('SIGKILL')
			await exited
			output.push(log)
		},
	}
	return server
}

async function api(path, { method = 'GET', body, directory: location } = {}) {
	const url = new URL(path, server.url)
	if (location) url.searchParams.set('location[directory]', location)
	const response = await fetch(url, {
		method,
		headers: { authorization, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(600000),
	})
	const text = await response.text()
	return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

const plugin = async (location, id) => {
	const { status, body } = await api('/api/plugin', { directory: location })
	assert.equal(status, 200, `Plugin listing failed: ${JSON.stringify(body)}`)
	return (body.data ?? body).find((entry) => entry.id === id)
}

// Location plugins activate asynchronously after readiness, so clients wait for the RPC owner.
async function activated(location) {
	const deadline = Date.now() + 30000
	for (;;) {
		const capsule = await plugin(location, 'capsule')
		assert.notEqual(capsule?.state.status, 'failed', 'The Capsule plugin failed to activate')
		if (capsule?.state.status === 'active') return
		assert(Date.now() < deadline, 'The Capsule plugin did not activate')
		await delay(50)
	}
}

async function rpc(method, input, location = paths.controlDirectory) {
	const { status, body } = await api(`/api/rpc/capsule/${method}`, {
		method: 'POST',
		body: { input },
		directory: location,
	})
	if (status === 200) return { output: body.output }
	assert.equal(status, 400, `Unexpected RPC response ${status}: ${JSON.stringify(body)}`)
	return { error: body }
}
const refused = async (method, input, code, message, location) => {
	const { error } = await rpc(method, input, location)
	assert.deepEqual([error?.type, error?.data?.code], ['rejected', code], message)
}

const query = (sql, ...parameters) => {
	const db = new DatabaseSync(database)
	try {
		return db.prepare(sql).all(...parameters)
	} finally {
		db.close()
	}
}
const workspaceRows = () => query('SELECT id, provider, binding FROM workspace ORDER BY id')

async function sessionLog(sessionID) {
	const response = await fetch(
		new URL(`/api/experimental/session/${sessionID}/log?follow=false`, server.url),
		{ headers: { authorization }, signal: AbortSignal.timeout(30000) },
	)
	assert.equal(response.status, 200)
	return (await response.text())
		.split('\n')
		.filter((line) => line.startsWith('data: '))
		.map((line) => JSON.parse(line.slice('data: '.length)))
}

async function shell(sessionID, command) {
	const before = (await sessionLog(sessionID)).length
	const { status, body } = await api(`/api/session/${sessionID}/shell`, {
		method: 'POST',
		body: { command },
	})
	assert.equal(status, 204, `Session shell failed: ${JSON.stringify(body)}`)
	const ended = (await sessionLog(sessionID))
		.slice(before)
		.find((event) => event.type === 'session.shell.ended')
	assert(ended, 'The session shell did not finish')
	return ended.data.output.output
}

async function writeWithAgent(sessionID, file) {
	const prompt = await api(`/api/session/${sessionID}/prompt`, {
		method: 'POST',
		body: { text: `WRITE ${file}` },
	})
	assert.equal(prompt.status, 200, `Prompt failed: ${JSON.stringify(prompt.body)}`)
	const waited = await api(`/api/experimental/session/${sessionID}/wait`, { method: 'POST' })
	assert.equal(waited.status, 204, `Session did not settle: ${JSON.stringify(waited.body)}`)
	const results = (await sessionLog(sessionID)).filter((event) =>
		event.type.startsWith('session.tool.'),
	)
	assert(
		results.some((event) => JSON.stringify(event).includes(file)),
		`The agent did not run its write tool: ${JSON.stringify(results)}`,
	)
}

const formatted = () =>
	readFile(paths.formatted, 'utf8').then(
		(text) => text.trim().split('\n'),
		(error) => {
			if (error.code === 'ENOENT') return []
			throw error
		},
	)

// Host Git without user or system configuration, for fixture repositories.
const findGit = async () => {
	for (const entry of runtime.basePath.split(delimiter)) {
		const candidate = join(entry, 'git')
		if (
			await execute(candidate, ['--version']).then(
				() => true,
				() => false,
			)
		)
			return candidate
	}
	assert.fail('The packaged base PATH has no Git')
}
const git = async (...args) => {
	const { stdout } = await execute(await findGit(), ['-c', 'core.hooksPath=/dev/null', ...args], {
		env: {
			PATH: runtime.basePath,
			HOME: paths.home,
			GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_AUTHOR_NAME: 'Fixture',
			GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
			GIT_COMMITTER_NAME: 'Fixture',
			GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
		},
	})
	return stdout.trimEnd()
}

/** Serves bare repositories below `base` over git:// on loopback, one daemon per connection. */
const serveGit = async (base) => {
	const executable = await findGit()
	const children = new Set()
	const sockets = new Set()
	const daemon = createServer((socket) => {
		sockets.add(socket)
		socket.once('close', () => sockets.delete(socket))
		socket.on('error', () => socket.destroy())
		const child = spawn(
			executable,
			['daemon', '--inetd', '--export-all', '--log-destination=none', `--base-path=${base}`],
			{ env: { PATH: runtime.basePath, HOME: paths.home }, stdio: ['pipe', 'pipe', 'ignore'] },
		)
		children.add(child)
		child.once('exit', () => children.delete(child))
		child.on('error', () => socket.destroy())
		child.stdin.on('error', () => {})
		socket.pipe(child.stdin)
		child.stdout.pipe(socket)
	})
	await new Promise((resolve) => daemon.listen(0, '127.0.0.1', resolve))
	return {
		prefix: `git://127.0.0.1:${daemon.address().port}/`,
		close: async () => {
			const closed = new Promise((resolve) => daemon.close(resolve))
			for (const socket of sockets) socket.destroy()
			for (const child of children) child.kill('SIGKILL')
			await closed
		},
	}
}

// A dev shell without flake inputs, so preparation never fetches nixpkgs.
const managedFlake = () => {
	const store = runtime.shell.split('/').slice(0, 4).join('/')
	return `{
  outputs = { self }: {
    devShells.${system}.default = builtins.derivation {
      name = "opencode-capsule-fixture";
      system = "${system}";
      builder = builtins.appendContext "${runtime.shell}" { "${store}" = { path = true; }; };
      outputs = [ "out" ];
      CAPSULE_FIXTURE = "managed";
    };
  };
}
`
}

/**
 * Publishes a fixture repository under its canonical GitHub URL. A Git wrapper ahead of the pinned
 * base PATH redirects https://github.com/ to a loopback daemon; production settings have no hook.
 */
async function publishFixture() {
	const seed = join(directory, 'seed')
	const remotes = join(directory, 'remotes')
	const repository = 'fixture/native'
	await git('init', '-q', '-b', 'main', seed)
	await writeFile(join(seed, 'flake.nix'), managedFlake())
	await writeFile(join(seed, 'flake.lock'), '{"nodes":{"root":{}},"root":"root","version":7}\n')
	await writeFile(join(seed, 'README.md'), 'fixture\n')
	await git('-C', seed, 'add', '.')
	await git('-C', seed, 'commit', '-q', '-m', 'fixture')
	await git('init', '-q', '--bare', '-b', 'main', join(remotes, `${repository}.git`))
	await git('-C', seed, 'push', '-q', join(remotes, `${repository}.git`), 'main')
	const daemon = await serveGit(remotes)
	const redirect = join(directory, 'opencode-capsule-git-redirect')
	await mkdir(join(redirect, 'bin'), { recursive: true })
	await writeFile(
		join(redirect, 'bin', 'git'),
		`#!${runtime.shell}\nexec ${await findGit()} -c url.${daemon.prefix}.insteadOf=https://github.com/ "$@"\n`,
	)
	await chmod(join(redirect, 'bin', 'git'), 0o555)
	const { stdout } = await execute(join(dirname(runtime.nix), 'nix-store'), ['--add', redirect])
	return {
		repository,
		close: daemon.close,
		runtime: { ...runtime, basePath: `${stdout.trim()}/bin:${runtime.basePath}` },
	}
}

async function writeOpenCodeConfig() {
	await writeFile(
		paths.config,
		JSON.stringify({
			default_agent: 'capsule-fixture',
			model: 'fixture/fixture',
			plugins: ['-opencode.browser'],
			formatter: {
				// Records every host-side formatter run.
				marker: {
					command: [
						runtime.shell,
						'-c',
						`echo "$1" >> ${JSON.stringify(paths.formatted)}`,
						'marker',
						'$FILE',
					],
					extensions: ['.txt'],
				},
			},
			providers: {
				fixture: {
					package: '@opencode/ai/providers/openai-compatible',
					env: [],
					settings: {
						baseURL: `http://127.0.0.1:${provider.address().port}/v1`,
						apiKey: 'fixture',
						transport: 'http',
					},
					models: {
						fixture: {
							limit: { context: 1000000, output: 16000 },
							capabilities: { tools: true, input: ['text'], output: ['text'] },
						},
					},
				},
			},
			agents: {
				'capsule-fixture': {
					mode: 'primary',
					description: 'Native Capsule placement fixture',
					model: 'fixture/fixture',
					system: 'Write the file the user names, then reply.',
					permissions: [{ action: 'edit', resource: '*', effect: 'allow' }],
				},
			},
		}),
	)
}

// Without namespaces: registration, the RPC contract, and refusals that need no sandbox.
async function registration() {
	await start()
	assert.equal((await fetch(new URL('/api/info', server.url))).status, 401)
	assert.equal(await plugin(paths.home, 'capsule'), undefined, 'Disabled hosts register no plugin')
	assert.equal((await rpc('info', {}, paths.home)).error?.type, 'rpc.unavailable')
	await server.stop()

	await writeFile(paths.hostConfig, JSON.stringify(settingsFor({ checkoutRoot: paths.root })))
	const unsafe = await start(paths.hostConfig)
	assert.equal(unsafe.url, undefined, 'Overlapping Capsule roots must fail server boot')
	await unsafe.exited
	assert.match(unsafe.log(), /Capsule host failed to start/)
	output.push(unsafe.log())

	await mkdir(paths.controlTarget, { mode: 0o700 })
	await symlink(paths.controlTarget, paths.controlAlias)
	const control = paths.controlAlias
	await writeFile(paths.hostConfig, JSON.stringify(settingsFor({ controlDirectory: control })))
	await start(paths.hostConfig)
	await activated(control)
	const { output: info, error } = await rpc('info', {}, control)
	assert(info, `The declared control alias must serve the Capsule RPC: ${JSON.stringify(error)}`)
	assert.deepEqual(info, {
		version: 1,
		storageId: info.storageId,
		checkoutRoot: paths.checkoutRoot,
	})
	assert.match(info.storageId, /^[0-9a-f]{32}$/)
	for (const location of [paths.home, paths.controlTarget]) {
		assert.equal(
			(await rpc('info', {}, location)).error?.type,
			'rpc.unavailable',
			'Only the declared control location serves the Capsule RPC',
		)
	}

	const reference = {
		storageId: info.storageId,
		workspaceId: 'wrk_missing',
		sessionId: 'ses_missing',
		owner,
	}
	await refused('getSession', reference, 'not_ready', 'A missing session is not ready', control)
	await refused(
		'getSession',
		{ ...reference, storageId: 'other' },
		'incompatible',
		'Storage is checked',
		control,
	)
	await server.stop()

	// A workspace another provider owns is refused before Capsule creates anything.
	const now = Date.now()
	const db = new DatabaseSync(database)
	db.prepare(
		'INSERT INTO workspace (id, provider, binding, created_at, last_used_at) VALUES (?, ?, NULL, ?, ?)',
	).run('wrk_foreign', 'foreign', now, now)
	db.close()
	await start(paths.hostConfig)
	await activated(control)
	await refused(
		'prepareSession',
		{
			...reference,
			workspaceId: 'wrk_foreign',
			sessionId: 'ses_foreign',
			source: { repository: 'fixture/native', ref: 'main', branch: 'task' },
			agent: 'capsule-fixture',
		},
		'ownership',
		'A workspace owned by another provider must be refused',
		control,
	)
	assert.deepEqual(
		workspaceRows().map(({ id, provider, binding }) => [id, provider, binding]),
		[['wrk_foreign', 'foreign', null]],
	)
	assert.deepEqual(await readdir(paths.checkoutRoot), [], 'Refusal must not create a checkout')
	await server.stop()
	return info
}

// With namespaces: managed preparation and workspace-bound native execution, across a restart.
async function placement(info) {
	const fixture = await publishFixture()
	try {
		await writeFile(paths.hostConfig, JSON.stringify(settingsFor({ runtime: fixture.runtime })))
		await start(paths.hostConfig)
		await activated(paths.controlDirectory)
		const reference = {
			storageId: info.storageId,
			workspaceId: 'wrk_native',
			sessionId: 'ses_native',
			owner,
		}
		const request = {
			...reference,
			source: { repository: fixture.repository, ref: 'main', branch: 'task-native' },
			agent: 'capsule-fixture',
			metadata: { purpose: 'native-proof' },
		}
		const checkout = join(paths.checkoutRoot, 'wrk_native', 'checkout')
		const expected = { workspaceId: 'wrk_native', sessionId: 'ses_native', directory: checkout }
		const prepared = await rpc('prepareSession', request)
		assert.deepEqual(prepared.output, expected, JSON.stringify(prepared.error))
		assert.deepEqual(
			(await rpc('prepareSession', request)).output,
			expected,
			'Prepare is idempotent',
		)
		const bound = { ...expected, capsulePhase: 'ready', workspaceState: 'bound' }
		assert.deepEqual((await rpc('getSession', reference)).output, bound)

		const workspace = workspaceRows().find(({ id }) => id === 'wrk_native')
		assert.deepEqual(
			{ provider: workspace.provider, binding: JSON.parse(workspace.binding) },
			{ provider: 'capsule', binding: { id: 'wrk_native', directory: checkout } },
		)
		const session = (await api('/api/session/ses_native')).body
		assert.equal(session.location?.directory ?? session.data?.location?.directory, checkout)

		await refused(
			'getSession',
			{ ...reference, owner: { ...owner, id: 'other' } },
			'ownership',
			'Owners are checked',
		)
		await refused(
			'prepareSession',
			{ ...request, workspaceId: 'wrk_other' },
			'ownership',
			'A session cannot move to another workspace',
		)

		const probe = [
			'set -eu',
			'printf "%s\\n" "$PWD" "$CAPSULE_FIXTURE" "$(readlink /proc/self/ns/pid)"',
			`test ! -e ${JSON.stringify(paths.formatted)} || echo leaked`,
			`test ! -e ${JSON.stringify(paths.config)} && echo isolated`,
		].join('\n')
		const hostNamespace = await readlink('/proc/self/ns/pid')
		const inside = async () => {
			const lines = (await shell('ses_native', probe)).trim().split('\n')
			assert.deepEqual(lines.slice(0, 2), [checkout, 'managed'], lines.join('\n'))
			assert.notEqual(lines[2], hostNamespace, 'Workspace shells must run in the Capsule')
			assert.equal(lines.at(-1), 'isolated', 'Host-only files must stay outside the Capsule')
		}
		await inside()

		await writeWithAgent('ses_native', 'workspace.txt')
		assert.equal(await readFile(join(checkout, 'workspace.txt'), 'utf8'), `${writeMarker}\n`)
		assert.deepEqual(await formatted(), [], 'Host formatters must not run for workspace files')

		await mkdir(paths.local)
		const local = await api('/api/session', {
			method: 'POST',
			body: { agent: 'capsule-fixture', location: { directory: paths.local } },
		})
		assert.equal(local.status, 200, JSON.stringify(local.body))
		const localID = local.body.id ?? local.body.data?.id
		await writeWithAgent(localID, 'local.txt')
		assert.deepEqual(
			await formatted(),
			[join(paths.local, 'local.txt')],
			'Local formatting remains',
		)

		// No in-memory state carries a session across restarts.
		await server.stop()
		await start(paths.hostConfig)
		await activated(paths.controlDirectory)
		assert.deepEqual((await rpc('getSession', reference)).output, bound)
		await inside()
		await server.stop()

		// Reads never recreate a vanished workspace; the retained session still proves identity.
		const manifestPath = join(paths.root, 'wrk_native', 'manifest.json')
		const manifest = await readFile(manifestPath, 'utf8')
		const db = new DatabaseSync(database)
		db.prepare('DELETE FROM workspace WHERE id = ?').run('wrk_native')
		db.close()
		await start(paths.hostConfig)
		await activated(paths.controlDirectory)
		assert.deepEqual((await rpc('getSession', reference)).output, {
			...bound,
			workspaceState: 'absent',
		})
		await refused(
			'prepareSession',
			request,
			'not_ready',
			'A retry cannot run without its workspace',
		)
		assert(!workspaceRows().some(({ id }) => id === 'wrk_native'), 'A read recreated the workspace')
		assert.equal(await readFile(manifestPath, 'utf8'), manifest, 'A read changed the Capsule')
		await server.stop()
	} finally {
		await fixture.close()
	}
}

try {
	for (const path of [paths.home, join(directory, 'config'), join(directory, 'data')])
		await mkdir(path, { recursive: true })
	await writeOpenCodeConfig()
	const info = await registration()
	if (mode !== '--without-namespaces') await placement(info)
	for (const log of output) assert(!log.includes(password), 'The server password leaked to output')
} catch (error) {
	if (server) {
		await server.stop()
		console.error(server.log())
	}
	throw error
} finally {
	provider.close()
	await rm(directory, { recursive: true, force: true })
}
