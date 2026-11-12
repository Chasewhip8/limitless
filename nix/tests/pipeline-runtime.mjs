import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
	access,
	chmod,
	constants,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createSocketServer } from 'node:net'
import { delimiter, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { NodeHttpClient, NodeServices } from '@effect/platform-node'
import { OpenCode } from '@opencode/client'
import { Effect, Layer, ManagedRuntime, Option, Schema, Stream } from 'effect'
import { CapsuleHostRpc } from '../../packages/capsule/src/host/contract.ts'
import { make as makeCapsule } from '../../packages/capsule/src/service.ts'
import { Manifest as SourceManifest } from '../../packages/capsule/src/source/state.ts'
import { PipelineConfig, PipelineSettings } from '../../packages/pipeline/config.ts'
import { GitHub } from '../../packages/pipeline/github/service.ts'
import { Scheduler, schedulerLayer } from '../../packages/pipeline/scheduler.ts'
import { newAssignment, sessionIdentity } from '../../packages/pipeline/tasks/placement.ts'
import { Tasks, tasksLayer } from '../../packages/pipeline/tasks/service.ts'
import { taskStoreLayer } from '../../packages/pipeline/tasks/store.ts'
import { OpenCodeWorker, openCodeWorkerLayer } from '../../packages/pipeline/worker/service.ts'
import { pullRequestSource } from '../../packages/pipeline/worker/source.ts'

// Bundled by pipeline.nix against the production dispatcher, adapter, and locked dependencies. It
// needs Bubblewrap, user namespaces, and the Nix daemon, so it runs on a host, not in a build.
const [opencodeExecutable, capsuleRuntimeConfig, expectedVersion, system] = process.argv.slice(2)
assert(opencodeExecutable && capsuleRuntimeConfig && expectedVersion && system)
assert.equal(expectedVersion, '2.2.7', 'Recheck the native contract when upgrading OpenCode')
process.umask(0o077)

const overallDeadline = 15 * 60_000
const commandDeadline = 120_000

function deferred() {
	let resolve
	const promise = new Promise((done) => {
		resolve = done
	})
	return { promise, resolve }
}

const runtimeSettings = JSON.parse(await readFile(capsuleRuntimeConfig, 'utf8'))
async function pinnedExecutable(name) {
	for (const directory of runtimeSettings.basePath.split(delimiter)) {
		const file = join(directory, name)
		if (
			await access(file, constants.X_OK).then(
				() => true,
				() => false,
			)
		)
			return file
	}
	assert.fail(`The pinned Capsule base PATH has no ${name}`)
}
const realGit = await pinnedExecutable('git')

await mkdir('/tmp/opencode', { recursive: true })
const directory = await realpath(await mkdtemp('/tmp/opencode/pipeline-runtime-'))
for (const name of [
	'home',
	'config',
	'data',
	'state',
	'cache',
	'xdg-runtime',
	'control',
	'identity',
	'secrets',
	'outside',
	'capsule-runtime',
	'sources',
	'remotes',
])
	await mkdir(join(directory, name), { mode: 0o700 })
const home = join(directory, 'home')
const controlDirectory = join(directory, 'control')
const capsuleRoot = join(directory, 'capsule-runtime')
const sourceRoot = join(directory, 'sources')
const password = randomUUID()
const credentialFile = join(directory, 'worker-password')
await writeFile(credentialFile, password, { mode: 0o600 })
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`

// Synthetic GitHub credentials: the configured token file is the only source Capsule may use;
// the native process environment and host gh configuration hold decoys commands must not see.
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const githubToken = `ghp_pipelineRuntime${randomUUID().replaceAll('-', '')}`
const decoys = [
	`ghp_pipelineDecoy${randomUUID().replaceAll('-', '')}`,
	`ghp_pipelineDecoy${randomUUID().replaceAll('-', '')}`,
	`ghp_pipelineDecoy${randomUUID().replaceAll('-', '')}`,
]
const tokenFile = join(directory, 'secrets', 'github-token')
await writeFile(tokenFile, `${githubToken}\n`, { mode: 0o600 })
const hostGhConfig = join(directory, 'config', 'gh', 'hosts.yml')
await mkdir(dirname(hostGhConfig), { recursive: true })
await writeFile(hostGhConfig, `github.com:\n    oauth_token: ${decoys[2]}\n`)
const hostSentinel = join(directory, 'outside', 'host-only')
const hostSentinelText = `PIPELINE_HOST_ONLY_${randomUUID()}`
await writeFile(hostSentinel, `${hostSentinelText}\n`)
const formatterMarker = join(directory, 'outside', 'host-formatter-ran')
const sanitize = (text) =>
	[password, authorization, githubToken, ...decoys].reduce(
		(result, secret) => result.replaceAll(secret, '[redacted]'),
		String(text),
	)

const readFileName = 'pipeline-runtime-read.txt'
const readMarker = 'PIPELINE_RUNTIME_TOOL_RESULT_2_2_7'
const readCallId = 'call_pipeline_fixture_read'
const linkCallId = 'call_pipeline_fixture_host_link'
const writeCallId = 'call_pipeline_fixture_write'
const shellCallId = 'call_pipeline_fixture_shell'
const sandboxMarker = 'PIPELINE_RUNTIME_SANDBOX_FIXTURE'
const sandboxProofMarker = 'PIPELINE_SANDBOX_PROOF_OK'
const agentNote = 'agent-note.txt'
const agentNoteText = 'written by the agent inside its Capsule\n'
const stopMarker = 'PIPELINE_RUNTIME_STOP_FIXTURE'
const firstPrompt = `${sandboxMarker}: read the fixture file, probe the sandbox, and reply.`
const repository = 'fixture/repository'
const fixtureUrl = `https://github.com/${repository}.git`
const prUrl = `https://github.com/${repository}/pull/1`
let phase = 'fixture setup'

// Host Git for fixture repositories, without user or system configuration.
const git = (...args) =>
	execFileSync(realGit, ['-c', 'core.hooksPath=/dev/null', ...args], {
		env: {
			PATH: runtimeSettings.basePath,
			HOME: home,
			GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_TERMINAL_PROMPT: '0',
			GIT_AUTHOR_NAME: 'Pipeline Fixture',
			GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
			GIT_COMMITTER_NAME: 'Pipeline Fixture',
			GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
		},
		encoding: 'utf8',
		timeout: commandDeadline,
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim()

// A dev shell without flake inputs, so preparation never fetches nixpkgs; its derivation
// attributes become project environment variables.
const store = runtimeSettings.shell.split('/').slice(0, 4).join('/')
const fixtureFlake = `{
  outputs = { self }: {
    devShells.${system}.default = builtins.derivation {
      name = "pipeline-runtime-fixture";
      system = "${system}";
      builder = builtins.appendContext "${runtimeSettings.shell}" { "${store}" = { path = true; }; };
      outputs = [ "out" ];
      CAPSULE_FIXTURE = "pipeline";
    };
  };
}
`

const seed = join(directory, 'seed')
const remote = join(directory, 'remotes', `${repository}.git`)
git('init', '-q', '--initial-branch', 'review-fixture', seed)
await writeFile(join(seed, 'review.txt'), 'base\n')
await writeFile(join(seed, readFileName), `${readMarker}\n`)
await writeFile(join(seed, 'flake.nix'), fixtureFlake)
await writeFile(join(seed, 'flake.lock'), '{"nodes":{"root":{}},"root":"root","version":7}\n')
// Project hooks record each lifecycle step in the retained checkout, which purging keeps.
const lifecycleLog = '.capsule-lifecycle.log'
const recordLifecycle = (step) => ['bash', '-c', `echo ${step} >> ${lifecycleLog}`]
await writeFile(
	join(seed, 'capsule.json'),
	JSON.stringify({
		setup: recordLifecycle('setup'),
		stop: recordLifecycle('stop'),
		purge: recordLifecycle('purge'),
	}),
)
git('-C', seed, 'add', '.')
git('-C', seed, 'commit', '-q', '--no-gpg-sign', '-m', 'base')
const baseSha = git('-C', seed, 'rev-parse', 'HEAD')
await writeFile(join(seed, 'review.txt'), 'head\n')
git('-C', seed, 'commit', '-q', '--no-gpg-sign', '-am', 'head')
const headSha = git('-C', seed, 'rev-parse', 'HEAD')
await mkdir(dirname(remote), { recursive: true })
git('clone', '-q', '--bare', '--no-hardlinks', seed, remote)
git('--git-dir', remote, 'update-ref', 'refs/pull/1/head', headSha)

async function movePullRequestHead() {
	await writeFile(join(seed, 'review.txt'), 'moved\n')
	git('-C', seed, 'commit', '-q', '--no-gpg-sign', '-am', 'moved')
	const moved = git('-C', seed, 'rev-parse', 'HEAD')
	git('-C', seed, 'push', '--quiet', remote, 'review-fixture')
	git('--git-dir', remote, 'update-ref', 'refs/pull/1/head', moved)
	return moved
}

/**
 * Serves the fixture remotes over git:// on loopback, one `git daemon --inetd` per connection.
 * Capsule's source engine clears global Git configuration, so canonical GitHub URLs reach it only
 * through a Git wrapper leading the fixture runtime's base PATH.
 */
const daemons = new Set()
const daemonSockets = new Set()
const gitServer = createSocketServer((socket) => {
	daemonSockets.add(socket)
	socket.once('close', () => daemonSockets.delete(socket))
	socket.on('error', () => socket.destroy())
	const daemon = spawn(
		realGit,
		[
			'daemon',
			'--inetd',
			'--export-all',
			'--log-destination=none',
			`--base-path=${join(directory, 'remotes')}`,
		],
		{ env: { PATH: runtimeSettings.basePath, HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] },
	)
	daemons.add(daemon)
	daemon.once('exit', () => daemons.delete(daemon))
	daemon.on('error', () => socket.destroy())
	daemon.stdin.on('error', () => {})
	socket.pipe(daemon.stdin)
	daemon.stdout.pipe(socket)
})
await new Promise((done, reject) => {
	gitServer.once('error', reject)
	gitServer.listen(0, '127.0.0.1', done)
})
async function closeGitServer() {
	const closed = new Promise((done) => gitServer.close(done))
	for (const socket of daemonSockets) socket.destroy()
	for (const daemon of daemons) daemon.kill('SIGKILL')
	await Promise.all([...daemons].map((daemon) => new Promise((done) => daemon.once('exit', done))))
	await closed
}

// Only a loopback port and public store paths enter the store; credentials never do.
const redirect = join(directory, 'pipeline-git-redirect')
await mkdir(join(redirect, 'bin'), { recursive: true })
await writeFile(
	join(redirect, 'bin', 'git'),
	`#!${runtimeSettings.shell}\nexec ${realGit} -c url.git://127.0.0.1:${gitServer.address().port}/.insteadOf=https://github.com/ "$@"\n`,
)
await chmod(join(redirect, 'bin', 'git'), 0o555)
const redirectStore = execFileSync(
	join(dirname(runtimeSettings.nix), 'nix-store'),
	['--add', redirect],
	{ encoding: 'utf8', timeout: commandDeadline, stdio: ['ignore', 'pipe', 'pipe'] },
).trim()
const fixtureRuntime = {
	...runtimeSettings,
	basePath: `${redirectStore}/bin${delimiter}${runtimeSettings.basePath}`,
}
const hostCredentials = {
	github: { tokenFile },
	identity: { name: 'Pipeline Fixture', email: 'fixture@example.invalid' },
}
const hostConfigFile = join(directory, 'capsule-host.json')
await writeFile(
	hostConfigFile,
	JSON.stringify({
		root: capsuleRoot,
		checkoutRoot: sourceRoot,
		controlDirectory,
		runtime: fixtureRuntime,
		credentials: hostCredentials,
	}),
)
assert(!(await readFile(hostConfigFile, 'utf8')).includes(githubToken))

// Loopback model: one genuine tool step per session, then free-form assistant text. The first
// adapter prompt also probes the Capsule sandbox through native read, write, and shell tools.
const modelRequests = []
const releaseFirst = deferred()
const firstStarted = deferred()
const stopStarted = deferred()
const stopClosed = deferred()
const releaseStop = deferred()
let providerFailure

function messageText(message) {
	if (typeof message.content === 'string') return message.content
	if (Array.isArray(message.content)) return message.content.map((part) => part.text ?? '').join('')
	return ''
}

const toolCall = (id, name, input) => ({
	id,
	type: 'function',
	function: { name, arguments: JSON.stringify(input) },
})
const toolResults = (messages, id) =>
	messages.filter((message) => message.role === 'tool' && message.tool_call_id === id)

function sandboxCalls(body) {
	for (const name of ['write', 'shell'])
		assert(
			body.tools?.some((entry) => entry.function?.name === name),
			`Pinned native ${name} tool must be offered to the review agent`,
		)
	return [
		toolCall(linkCallId, 'read', { path: 'host-link' }),
		toolCall(writeCallId, 'write', { path: agentNote, content: agentNoteText }),
		toolCall(shellCallId, 'shell', {
			command: 'bash ./.pipeline-sandbox-proof.sh',
			timeout: 60000,
		}),
	]
}

function checkSandboxResults(messages) {
	const [link] = toolResults(messages, linkCallId)
	assert(link, 'The host-link read must have a result')
	const linkText = JSON.stringify(link.content)
	assert(linkText.includes('File not found'), 'The sandboxed read must not resolve the host link')
	assert(!linkText.includes(hostSentinelText), 'Host-only content reached the agent')
	assert(toolResults(messages, writeCallId).length === 1, 'The write must have one result')
	const [shell] = toolResults(messages, shellCallId)
	assert(
		JSON.stringify(shell?.content).includes(sandboxProofMarker),
		`The Capsule shell proof failed: ${sanitize(JSON.stringify(shell?.content))}`,
	)
}

async function modelResponse(body, headers, response) {
	if (headers['x-fixture-kind'] !== 'primary') return { content: 'Fixture title' }
	const sessionId = headers['x-fixture-session']
	assert.equal(headers['x-fixture-agent'], 'review')
	const messages = body.messages
	const request = { sessionId, messages, index: modelRequests.length }
	modelRequests.push(request)
	const sessionRequests = modelRequests.filter((entry) => entry.sessionId === sessionId)
	const lastUser = messages.findLast((message) => message.role === 'user')
	if (messageText(lastUser).includes(stopMarker)) {
		response.once('close', () => stopClosed.resolve())
		stopStarted.resolve()
		await Promise.race([releaseStop.promise, stopClosed.promise])
		return { content: 'Stopped fixture text that native interruption must discard.' }
	}
	const sandboxed = messageText(messages.find((message) => message.role === 'user')).includes(
		sandboxMarker,
	)
	if (toolResults(messages, readCallId).length === 0) {
		// https://github.com/anomalyco/opencode/blob/fedc6f208aa2bd54c1019227214568083f6380ad/packages/core/src/tool/plugin/read.ts
		const tool = body.tools?.find((entry) => entry.function?.name === 'read')
		assert(tool, 'Pinned native read tool must be offered to the review agent')
		assert(tool.function.parameters.required.includes('path'))
		if (modelRequests.length === 1) {
			firstStarted.resolve()
			await releaseFirst.promise
		}
		const read = toolCall(readCallId, 'read', { path: readFileName, offset: 1, limit: 20 })
		const calls = sandboxed ? [read, ...sandboxCalls(body)] : [read]
		return { tool_calls: calls.map((call, index) => ({ index, ...call })) }
	}
	const results = toolResults(messages, readCallId)
	assert.equal(results.length, 1, 'The conversation must contain exactly one genuine read result')
	assert(JSON.stringify(results[0].content).includes(readMarker))
	if (sandboxed) checkSandboxResults(messages)
	return { content: `Fixture free-form review text ${sessionRequests.length} for ${sessionId}.` }
}

const provider = createServer(async (request, response) => {
	try {
		assert.equal(request.url, '/v1/chat/completions')
		let text = ''
		for await (const chunk of request) text += chunk
		const delta = await modelResponse(JSON.parse(text), request.headers, response)
		if (response.destroyed) return
		const chunk = (delta, finish_reason = null) => ({
			id: 'chatcmpl_pipeline_fixture',
			object: 'chat.completion.chunk',
			created: 1,
			model: 'fixture',
			choices: [{ index: 0, delta, finish_reason }],
		})
		response.writeHead(200, { 'content-type': 'text/event-stream' })
		for (const value of [
			chunk({ role: 'assistant' }),
			chunk(delta),
			chunk({}, delta.tool_calls ? 'tool_calls' : 'stop'),
		])
			response.write(`data: ${JSON.stringify(value)}\n\n`)
		response.end('data: [DONE]\n\n')
	} catch (error) {
		providerFailure ??= error
		if (!response.headersSent) response.writeHead(500)
		response.end('Local fixture rejected the request')
	}
})
await new Promise((done) => provider.listen(0, '127.0.0.1', done))
const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`

// The established T3 fixture uses this hook only to label model requests.
await writeFile(join(directory, 'identity', 'package.json'), JSON.stringify({ type: 'module' }))
await writeFile(
	join(directory, 'identity', 'index.js'),
	`export default {id:'pipeline-runtime-identity',async setup(ctx){await ctx.session.hook('model.request',async event=>{const session=await ctx.session.get({sessionID:event.sessionID});event.headers['x-fixture-session']=event.sessionID;event.headers['x-fixture-agent']=session.agent;event.headers['x-fixture-kind']=event.kind})}}`,
)
const configFile = join(directory, 'opencode.json')
await writeFile(
	configFile,
	JSON.stringify({
		default_agent: 'review',
		model: 'fixture/fixture',
		plugins: ['-opencode.browser', join(directory, 'identity')],
		// Run on the host, this explicit formatter would leave a marker the Capsule cannot reach.
		formatter: {
			'pipeline-host-marker': {
				command: [runtimeSettings.shell, '-c', `printf ran > ${formatterMarker}`],
				extensions: ['.txt'],
			},
		},
		providers: {
			fixture: {
				package: '@opencode/ai/providers/openai-compatible',
				env: [],
				settings: { baseURL: providerUrl, apiKey: 'fixture', transport: 'http' },
				models: {
					fixture: {
						limit: { context: 1000000, output: 16000 },
						capabilities: { tools: true, input: ['text'], output: ['text'] },
					},
				},
			},
		},
		agents: {
			review: {
				mode: 'primary',
				description: 'Isolated Pipeline compatibility fixture',
				model: 'fixture/fixture',
				system: 'Read the fixture file once, then reply in free-form text.',
				permissions: [
					{ action: 'read', resource: readFileName, effect: 'allow' },
					{ action: 'read', resource: 'host-link', effect: 'allow' },
					{ action: 'edit', resource: agentNote, effect: 'allow' },
					{ action: 'shell', resource: '*', effect: 'allow' },
				],
			},
		},
	}),
)

let output = ''
let server
let exited
let base

async function start() {
	const ready = deferred()
	server = spawn(
		resolve(opencodeExecutable),
		['serve', '--hostname', '127.0.0.1', '--port', '0', '--log-level', 'debug'],
		{
			cwd: controlDirectory,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				PATH: `${fixtureRuntime.basePath}${delimiter}${process.env.PATH ?? ''}`,
				SHELL: runtimeSettings.shell,
				HOME: home,
				XDG_CONFIG_HOME: join(directory, 'config'),
				XDG_DATA_HOME: join(directory, 'data'),
				XDG_STATE_HOME: join(directory, 'state'),
				XDG_CACHE_HOME: join(directory, 'cache'),
				XDG_RUNTIME_DIR: join(directory, 'xdg-runtime'),
				GIT_CONFIG_NOSYSTEM: '1',
				GH_TOKEN: decoys[0],
				GITHUB_TOKEN: decoys[1],
				OPENCODE_CAPSULE_CONFIG: hostConfigFile,
				OPENCODE_CONFIG_DIR: join(directory, 'config', 'opencode'),
				OPENCODE_CONFIG: configFile,
				OPENCODE_CONFIG_PROJECT_DISABLE: '1',
				OPENCODE_DISABLE_MODELS_FETCH: '1',
				OPENCODE_DISABLE_FILEWATCHER: '1',
				OPENCODE_DISABLE_FFF: '1',
				OPENCODE_DISABLE_CLAUDE_CODE: '1',
				OPENCODE_PASSWORD: password,
			},
		},
	)
	let announcement = ''
	server.stdout.on('data', (chunk) => {
		output += chunk
		announcement += chunk
		const match = /server listening on (http:\/\/127\.0\.0\.1:[0-9]+)/.exec(announcement)
		if (match) ready.resolve(match[1])
	})
	server.stderr.on('data', (chunk) => {
		output += chunk
	})
	exited = new Promise((done) => {
		server.once('exit', (code, signal) => {
			done({ code, signal })
			ready.resolve(undefined)
		})
		server.once('error', (error) => {
			output += `Native server failed to start: ${error.message}\n`
			done({ code: null, signal: null })
			ready.resolve(undefined)
		})
	})
	base = await Promise.race([
		ready.promise,
		delay(30000, undefined, { ref: false }).then(() => {
			throw new Error('Isolated OpenCode server did not announce readiness')
		}),
	])
	assert(base, 'Isolated OpenCode server exited before readiness')
	assert.equal((await fetch(new URL('/api/info', base))).status, 401)
	await waitForPlugins()
	await waitForCapsuleHost()
}

async function stop() {
	if (!server || server.exitCode !== null || server.signalCode !== null) return
	server.kill('SIGTERM')
	const result = await Promise.race([exited, delay(10000, null, { ref: false })])
	if (!result) {
		server.kill('SIGKILL')
		await exited
		throw new Error('Isolated OpenCode server did not stop after SIGTERM')
	}
}

const client = () => OpenCode.make({ baseUrl: base, headers: { authorization } })
const capsuleHost = () => client().rpc(CapsuleHostRpc)
const atControl = { location: { directory: controlDirectory } }

// Cold plugin activation is asynchronous after the listening announcement.
async function waitForPlugins() {
	const deadline = Date.now() + 15000
	for (;;) {
		const { data } = await client().plugin.list()
		const required = ['pipeline-runtime-identity', 'opencode.config.agent'].map((id) =>
			data.find((plugin) => plugin.id === id),
		)
		assert(!required.some((plugin) => plugin?.state.status === 'failed'), 'Fixture plugin failed')
		if (required.every((plugin) => plugin?.state.status === 'active')) return
		assert(Date.now() < deadline, 'Fixture plugins did not activate')
		await delay(25)
	}
}

// The host registers its RPC on its control location after activation; `info` is read-only.
async function waitForCapsuleHost() {
	const deadline = Date.now() + 30000
	for (;;) {
		const info = await capsuleHost()
			.info({}, atControl)
			.catch((error) => {
				assert(Date.now() < deadline, `Capsule host RPC never registered: ${sanitize(error)}`)
				return undefined
			})
		if (info) return info
		await delay(50)
	}
}

async function journal(sessionID) {
	const entries = []
	for await (const entry of client().experimental.session.log({ sessionID, follow: false })) {
		entries.push(entry)
		if (entry.type === 'log.synced') break
	}
	assert.equal(entries.at(-1)?.type, 'log.synced', 'Native log ended before its durable watermark')
	return entries
}

const count = (entries, type) => entries.filter((entry) => entry.type === type).length
const enqueued = (entries) =>
	entries
		.filter((entry) => entry.type === 'session.inbox.enqueued' && entry.data.item.type === 'user')
		.map((entry) => entry.data.inboxID)
const sessionRequests = (sessionId) =>
	modelRequests.filter((request) => request.sessionId === sessionId)
const conversation = (request) => JSON.stringify(request.messages)

async function nativeDatabase() {
	const root = join(directory, 'data')
	const candidates = (await readdir(root, { recursive: true })).filter((file) =>
		file.endsWith('.db'),
	)
	for (const file of candidates) {
		const db = new DatabaseSync(join(root, file), { readOnly: true })
		try {
			const table = db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'")
				.get()
			if (table) return join(root, file)
		} finally {
			db.close()
		}
	}
	assert.fail('The isolated native database was not found')
}

// The public session view omits workspace placement; the isolated native database records it.
async function nativePlacement(sessionId, workspaceId) {
	const db = new DatabaseSync(await nativeDatabase(), { readOnly: true })
	try {
		const session = db
			.prepare('SELECT workspace_id, directory FROM session_v2 WHERE id = ?')
			.get(sessionId)
		const workspace = db
			.prepare('SELECT provider, binding FROM workspace WHERE id = ?')
			.get(workspaceId)
		return {
			session: session && { workspaceId: session.workspace_id, directory: session.directory },
			workspace: workspace && {
				provider: workspace.provider,
				binding: workspace.binding === null ? null : JSON.parse(workspace.binding),
			},
		}
	} finally {
		db.close()
	}
}

const placement = (identity, capsulePhase, workspaceState) => ({
	workspaceId: identity.workspaceId,
	sessionId: identity.sessionId,
	directory: identity.directory,
	capsulePhase,
	workspaceState,
})

const getSession = (identity) =>
	capsuleHost().getSession(
		{
			storageId: identity.storageId,
			workspaceId: identity.workspaceId,
			sessionId: identity.sessionId,
			owner: { namespace: 'pipeline', id: identity.taskId },
		},
		atControl,
	)

/** Proves the native rows and the host's read-only placement of a bound, workspace-placed session. */
async function expectPlaced(identity, capsulePhase = 'ready') {
	assert.deepEqual(await nativePlacement(identity.sessionId, identity.workspaceId), {
		session: { workspaceId: identity.workspaceId, directory: identity.directory },
		workspace: {
			provider: 'capsule',
			binding: { id: identity.workspaceId, directory: identity.directory },
		},
	})
	assert.deepEqual(await getSession(identity), placement(identity, capsulePhase, 'bound'))
}

/** Operator actuation of the retained Capsule with the host's own settings, outside OpenCode. */
const operateCapsule = (operation) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const capsule = yield* makeCapsule({
				root: capsuleRoot,
				runtime: fixtureRuntime,
				credentials: hostCredentials,
				checkoutRoot: sourceRoot,
			})
			return yield* operation(capsule)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.timeout('2 minutes')),
	)

const lifecycle = async (identity) =>
	(await readFile(join(identity.directory, lifecycleLog), 'utf8')).trim().split('\n')

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))
const sourceManifestFile = (workspaceId) => join(sourceRoot, workspaceId, 'manifest.json')
const capsuleManifestFile = (workspaceId) => join(capsuleRoot, workspaceId, 'manifest.json')

async function expectRetainedCapsule(identity, source) {
	const request = { id: identity.workspaceId, ...source }
	const sourceManifest = Schema.decodeUnknownSync(SourceManifest)(
		await readJson(sourceManifestFile(identity.workspaceId)),
	)
	assert.deepEqual(sourceManifest.request, request)
	assert.deepEqual(sourceManifest.resolved, { kind: 'branch', commit: source.commit })
	assert.deepEqual(sourceManifest.status, {
		_tag: 'Ready',
		id: identity.workspaceId,
		directory: identity.directory,
	})
	const capsule = await readJson(capsuleManifestFile(identity.workspaceId))
	assert.equal(capsule.owner, 'limitless-capsule-v2')
	assert.equal(capsule.phase, 'ready')
	assert.equal(capsule.spec.id, identity.workspaceId)
	assert.equal(capsule.spec.directory, identity.directory)
	assert.deepEqual(capsule.source, { root: sourceRoot, request, commit: source.commit })
}

const runtime = ManagedRuntime.make(
	openCodeWorkerLayer.pipe(
		Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
	),
)
const call = (effect, deadline = '60 seconds') =>
	runtime.runPromise(effect.pipe(Effect.timeout(deadline)))
const rejected = (effect) => call(Effect.flip(effect))
const adapter = await runtime.runPromise(
	Effect.gen(function* () {
		return yield* OpenCodeWorker
	}),
)
const workerAt = (url) => ({
	id: 'fixture',
	url,
	credentialFile,
	controlDirectory,
	system,
	capacity: 1,
	openCodeVersion: expectedVersion,
})
const pullRequest = (head) => ({
	url: prUrl,
	repository,
	sourceRepository: repository,
	repositoryId: 1,
	sourceRepositoryId: 1,
	number: 1,
	headRef: 'review-fixture',
	headSha: head,
	baseSha,
})
// Capsule creation evaluates the project dev shell through the host Nix daemon.
const prepareDeadline = '8 minutes'

async function waitForObservation(worker, identity, messageId, accepted) {
	const deadline = Date.now() + 30000
	for (;;) {
		// Native retries a rejected model request, so report the fixture's reason instead of waiting.
		assert.ifError(providerFailure)
		const observed = await call(adapter.observe(worker, identity, messageId))
		if (accepted.includes(observed._tag)) return observed
		assert(
			['NotObserved', 'Pending', 'Running'].includes(observed._tag),
			`Unexpected native observation ${JSON.stringify(observed)}`,
		)
		assert(Date.now() < deadline, `Native observation never reached ${accepted.join('/')}`)
		await delay(25)
	}
}

async function expectUnknownSession(worker, info) {
	const taskId = randomUUID()
	const identity = sessionIdentity({ id: taskId }, newAssignment(worker, info, taskId))
	await rejected(adapter.requirePlacement(worker, identity))
	await assert.rejects(client().session.get({ sessionID: identity.sessionId }))
	for (const root of [sourceRoot, capsuleRoot])
		await assert.rejects(stat(join(root, identity.workspaceId)), { code: 'ENOENT' })
	assert.deepEqual(await nativePlacement(identity.sessionId, identity.workspaceId), {
		session: undefined,
		workspace: undefined,
	})
}

async function verifyAdapter() {
	phase = 'worker readiness and Capsule host information'
	let worker = workerAt(base)
	const info = await call(adapter.ready(worker))
	assert.equal(info.version, 1)
	assert.equal(info.checkoutRoot, sourceRoot)
	assert.deepEqual(await capsuleHost().info({}, atControl), info)
	const taskId = randomUUID()
	const compact = taskId.replaceAll('-', '')
	const assignment = newAssignment(worker, info, taskId)
	assert.deepEqual(assignment, {
		workerId: worker.id,
		workerUrl: worker.url,
		controlDirectory,
		storageId: info.storageId,
		workspaceId: `wrk_pipeline${compact}`,
		sessionId: `ses_pipeline${compact}`,
		directory: join(sourceRoot, `wrk_pipeline${compact}`, 'checkout'),
	})
	const identity = sessionIdentity({ id: taskId }, assignment)
	const source = await runtime.runPromise(pullRequestSource(pullRequest(headSha)))
	const request = { source, pr: prUrl }

	phase = 'Capsule-backed session preparation through the host RPC'
	await call(adapter.prepareSession(worker, identity, request), prepareDeadline)
	await call(adapter.prepareSession(worker, identity, request), prepareDeadline)
	await call(adapter.requirePlacement(worker, identity))
	await expectRetainedCapsule(identity, source)
	assert.equal(git('-C', identity.directory, 'rev-parse', 'HEAD'), headSha)
	assert.equal(git('-C', identity.directory, 'rev-parse', '--is-shallow-repository'), 'false')
	assert.equal(git('-C', identity.directory, 'config', 'remote.origin.url'), fixtureUrl)
	git('-C', identity.directory, 'cat-file', '-e', `${baseSha}^{commit}`)
	const session = await client().session.get({ sessionID: identity.sessionId })
	assert.equal(session.id, identity.sessionId)
	assert.equal(session.location.directory, identity.directory)
	assert.equal(session.agent, 'review')
	assert.deepEqual(session.metadata, {
		pipeline: { taskId, pr: prUrl },
		capsule: { owner: { namespace: 'pipeline', id: taskId }, agent: 'review' },
	})
	assert(!session.permissions?.length, 'The adapter must not force session permissions')
	await expectPlaced(identity)
	assert.deepEqual(await call(adapter.observe(worker, identity)), { _tag: 'Idle' })

	phase = 'retained Capsule source ignores a moved remote head'
	await writeFile(join(identity.directory, 'unpublished.txt'), 'retained unpublished work\n')
	git('-C', identity.directory, 'commit', '-q', '--no-gpg-sign', '--allow-empty', '-m', 'local')
	const localHead = git('-C', identity.directory, 'rev-parse', 'HEAD')
	const sourceLedger = await readFile(sourceManifestFile(identity.workspaceId), 'utf8')
	const movedSha = await movePullRequestHead()
	await call(adapter.prepareSession(worker, identity, request), prepareDeadline)
	const moved = await runtime.runPromise(pullRequestSource(pullRequest(movedSha)))
	const collision = await rejected(
		adapter.prepareSession(worker, identity, { source: moved, pr: prUrl }),
	)
	assert.equal(collision.code, 'ownership')
	assert.equal(git('-C', identity.directory, 'rev-parse', 'HEAD'), localHead)
	assert.equal(
		await readFile(join(identity.directory, 'unpublished.txt'), 'utf8'),
		'retained unpublished work\n',
	)
	assert.equal(await readFile(sourceManifestFile(identity.workspaceId), 'utf8'), sourceLedger)

	phase = 'initial admission, native running view, and read-only reconciliation'
	await symlink(hostSentinel, join(identity.directory, 'host-link'))
	const capsuleHome = join(capsuleRoot, identity.workspaceId, 'home')
	const envHashes = `env -0 | while IFS= read -r -d '' entry; do printf %s "\${entry#*=}" | sha256sum; done`
	await writeFile(
		join(identity.directory, '.pipeline-sandbox-proof.sh'),
		[
			'set -uo pipefail',
			'fail() { echo "Capsule sandbox check failed: $1"; exit 1; }',
			`test "$PWD" = ${JSON.stringify(identity.directory)} || fail directory`,
			`test "$HOME" = ${JSON.stringify(capsuleHome)} || fail home`,
			`test "\${CAPSULE_FIXTURE:-}" = pipeline || fail dev-shell`,
			`test -z "\${GITHUB_TOKEN:-}" || fail github-token-variable`,
			`test "$(printf %s "\${GH_TOKEN:-}" | sha256sum | cut -d ' ' -f 1)" = ${sha256(githubToken)} || fail gh-token-variable`,
			`test "$(printf %s "$(gh auth token)" | sha256sum | cut -d ' ' -f 1)" = ${sha256(githubToken)} || fail gh-auth-token`,
			...decoys.map(
				(decoy, index) =>
					`test "$(${envHashes} | grep -c ${sha256(decoy)} || :)" = 0 || fail decoy-${index}`,
			),
			...[hostSentinel, hostGhConfig, home].map(
				(file, index) => `test ! -e ${JSON.stringify(file)} || fail host-path-${index}`,
			),
			'printf capsule > "$HOME/pipeline-home-marker" || fail home-write',
			`echo ${sandboxProofMarker}`,
		].join('\n'),
	)
	const firstMessage = `msg_pipeline${randomUUID().replaceAll('-', '')}`
	assert.deepEqual(await call(adapter.admit(worker, identity, firstMessage, firstPrompt)), {
		sessionId: identity.sessionId,
		messageId: firstMessage,
	})
	await firstStarted.promise
	assert.deepEqual(await waitForObservation(worker, identity, firstMessage, ['Running']), {
		_tag: 'Running',
		backgroundJobs: 0,
	})
	assert.deepEqual(await call(adapter.findAdmission(worker, identity, firstMessage, firstPrompt)), {
		sessionId: identity.sessionId,
		messageId: firstMessage,
	})
	releaseFirst.resolve()
	await waitForObservation(worker, identity, firstMessage, ['Idle'])
	assert.ifError(providerFailure)
	assert.equal(sessionRequests(identity.sessionId).length, 2, 'One tool step and one text step')

	phase = 'native tools ran inside the Capsule'
	assert.equal(await readFile(join(identity.directory, agentNote), 'utf8'), agentNoteText)
	await assert.rejects(stat(formatterMarker), { code: 'ENOENT' }, 'A host formatter ran')
	assert.equal(await readFile(join(capsuleHome, 'pipeline-home-marker'), 'utf8'), 'capsule')
	await assert.rejects(stat(join(home, 'pipeline-home-marker')), { code: 'ENOENT' })

	phase = 'read-only reconciliation of the initial admission'
	assert.deepEqual(await call(adapter.findAdmission(worker, identity, firstMessage, firstPrompt)), {
		sessionId: identity.sessionId,
		messageId: firstMessage,
	})
	const unknownMessage = `msg_pipeline${randomUUID().replaceAll('-', '')}`
	assert.equal(
		await call(adapter.findAdmission(worker, identity, unknownMessage, firstPrompt)),
		undefined,
	)
	assert.deepEqual(await call(adapter.observe(worker, identity, unknownMessage)), {
		_tag: 'NotObserved',
	})
	const conflict = await rejected(
		adapter.findAdmission(worker, identity, firstMessage, `${firstPrompt} changed`),
	)
	assert.equal(conflict.code, 'ownership')
	const initial = await journal(identity.sessionId)
	assert.deepEqual(enqueued(initial), [firstMessage], 'Reconciliation must not enqueue a prompt')
	assert.equal(count(initial, 'session.tool.success'), 3)
	assert.equal(count(initial, 'session.tool.failed'), 1)
	assert.equal(count(initial, 'session.execution.succeeded'), 1)

	phase = 'native restart adopts retained history without recreating sessions'
	await stop()
	await start()
	worker = workerAt(base)
	assert.deepEqual(await call(adapter.ready(worker)), info)
	await call(adapter.requirePlacement(worker, identity))
	await expectPlaced(identity)
	assert.deepEqual(await call(adapter.observe(worker, identity, firstMessage)), { _tag: 'Idle' })
	assert.deepEqual(await call(adapter.findAdmission(worker, identity, firstMessage, firstPrompt)), {
		sessionId: identity.sessionId,
		messageId: firstMessage,
	})
	await expectUnknownSession(worker, info)

	phase = 'resume in the same native session and Capsule checkout'
	const resumeMessage = `msg_pipeline${randomUUID().replaceAll('-', '')}`
	const resumePrompt = 'PIPELINE_RUNTIME_RESUME_FIXTURE: continue the retained conversation.'
	await call(adapter.admit(worker, identity, resumeMessage, resumePrompt))
	await waitForObservation(worker, identity, resumeMessage, ['Idle'])
	const resumed = sessionRequests(identity.sessionId)
	assert.equal(resumed.length, 3, 'Resume must make exactly one more model step')
	for (const text of [firstPrompt, readMarker, resumePrompt, 'Fixture free-form review text 2'])
		assert(conversation(resumed[2]).includes(text), `Resumed conversation lacks ${text}`)
	const afterResume = await journal(identity.sessionId)
	assert.deepEqual(enqueued(afterResume), [firstMessage, resumeMessage])
	assert.equal(count(afterResume, 'session.created'), 1)
	assert.equal(count(afterResume, 'session.execution.succeeded'), 2)

	phase = 'operator stops the Capsule while its native turn waits on the model'
	assert.deepEqual(await lifecycle(identity), ['setup'])
	const stopMessage = `msg_pipeline${randomUUID().replaceAll('-', '')}`
	const stopPrompt = `${stopMarker}: wait for interruption.`
	await call(adapter.admit(worker, identity, stopMessage, stopPrompt))
	await stopStarted.promise
	assert.equal(
		(await waitForObservation(worker, identity, stopMessage, ['Running']))._tag,
		'Running',
	)
	const stoppedCapsule = await operateCapsule((capsule) => capsule.stop(identity.workspaceId))
	assert.equal(stoppedCapsule.phase, 'stopped')
	assert.deepEqual(await lifecycle(identity), ['setup', 'stop'])

	phase = 'a stopped Capsule keeps identity reads and native interrupt, without revival'
	const stoppedPlacement = placement(identity, 'stopped', 'bound')
	assert.deepEqual(await getSession(identity), stoppedPlacement)
	assert.deepEqual(await call(adapter.requirePlacement(worker, identity)), stoppedPlacement)
	assert.deepEqual(await call(adapter.findAdmission(worker, identity, stopMessage, stopPrompt)), {
		sessionId: identity.sessionId,
		messageId: stopMessage,
	})
	assert.equal(
		(await waitForObservation(worker, identity, stopMessage, ['Running']))._tag,
		'Running',
	)
	await rejected(adapter.prepareSession(worker, identity, request))
	assert.deepEqual(await call(adapter.interrupt(worker, identity)), {
		sessionId: identity.sessionId,
	})
	await waitForObservation(worker, identity, stopMessage, ['Idle'])
	await Promise.race([
		stopClosed.promise,
		delay(10000, undefined, { ref: false }).then(() => {
			throw new Error('Native interrupt did not abort the active model request')
		}),
	])
	releaseStop.resolve()
	const stopped = await journal(identity.sessionId)
	assert.deepEqual(enqueued(stopped), [firstMessage, resumeMessage, stopMessage])
	assert.equal(count(stopped, 'session.execution.interrupted'), 1)
	assert.equal(sessionRequests(identity.sessionId).length, 4)
	assert.ifError(providerFailure)
	assert.equal((await readJson(capsuleManifestFile(identity.workspaceId))).phase, 'stopped')
	assert.deepEqual(await lifecycle(identity), ['setup', 'stop'])

	phase = 'a purged Capsule retains its native session, history, and checkout'
	const purgedCapsule = await operateCapsule((capsule) => capsule.purge(identity.workspaceId))
	assert.equal(purgedCapsule.phase, 'purged')
	assert.deepEqual(
		(await lifecycle(identity)).filter((step) => step === 'setup'),
		['setup'],
	)
	assert.equal((await lifecycle(identity)).at(-1), 'purge')
	await expectPlaced(identity, 'purged')
	await expectRetainedHistory(worker, identity, [firstMessage, resumeMessage, stopMessage])
	assert.equal(git('-C', identity.directory, 'rev-parse', 'HEAD'), localHead)
	assert.equal(
		await readFile(join(identity.directory, 'unpublished.txt'), 'utf8'),
		'retained unpublished work\n',
	)
	await rejected(adapter.prepareSession(worker, identity, request))
	assert.equal((await readJson(capsuleManifestFile(identity.workspaceId))).phase, 'purged')

	phase = 'history survives removal of the native workspace after the purge'
	await stop()
	const database = await nativeDatabase()
	const writable = new DatabaseSync(database)
	try {
		const removed = writable.prepare('DELETE FROM workspace WHERE id = ?').run(identity.workspaceId)
		assert.equal(removed.changes, 1)
	} finally {
		writable.close()
	}
	await start()
	worker = workerAt(base)
	const absent = placement(identity, 'purged', 'absent')
	assert.deepEqual(await getSession(identity), absent)
	assert.deepEqual(await call(adapter.requirePlacement(worker, identity)), absent)
	await expectRetainedHistory(worker, identity, [firstMessage, resumeMessage, stopMessage])
	assert.deepEqual(await nativePlacement(identity.sessionId, identity.workspaceId), {
		session: { workspaceId: identity.workspaceId, directory: identity.directory },
		workspace: undefined,
	})
	assert.equal((await readJson(capsuleManifestFile(identity.workspaceId))).phase, 'purged')
	assert.equal(await readFile(sourceManifestFile(identity.workspaceId), 'utf8'), sourceLedger)
	assert.deepEqual(
		(await lifecycle(identity)).filter((step) => step === 'setup'),
		['setup'],
	)
	return { worker, info, movedSha, adapterSession: identity.sessionId }
}

async function expectRetainedHistory(worker, identity, messages) {
	assert.deepEqual(await call(adapter.observe(worker, identity, messages.at(-1))), {
		_tag: 'Idle',
	})
	assert.deepEqual(await call(adapter.findAdmission(worker, identity, messages[0], firstPrompt)), {
		sessionId: identity.sessionId,
		messageId: messages[0],
	})
	const history = await journal(identity.sessionId)
	assert.deepEqual(enqueued(history), messages)
	assert.equal(count(history, 'session.created'), 1)
	assert.equal(count(history, 'session.execution.interrupted'), 1)
	const session = await client().session.get({ sessionID: identity.sessionId })
	assert.equal(session.location.directory, identity.directory)
}

async function verifyCoordinator(worker, info, movedSha) {
	phase = 'coordinator submit through production tasks, scheduler, and adapter'
	const database = join(directory, 'coordinator.sqlite')
	const pr = pullRequest(movedSha)
	const settings = Schema.decodeUnknownSync(PipelineSettings)({
		host: '127.0.0.1',
		port: 4848,
		database,
		apiTokenFile: credentialFile,
		githubTokenFile: null,
		pollIntervalMs: 100,
		queueTimeoutMs: 600000,
		workers: [worker],
	})
	const infrastructure = Layer.mergeAll(
		Layer.succeed(PipelineConfig, settings),
		taskStoreLayer(database),
		NodeServices.layer,
		NodeHttpClient.layerNodeHttp,
	)
	const services = Layer.mergeAll(
		tasksLayer.pipe(Layer.provide(Layer.succeed(GitHub, { resolve: () => Effect.succeed(pr) }))),
		schedulerLayer,
	).pipe(Layer.provide(openCodeWorkerLayer), Layer.provideMerge(infrastructure))

	const program = Effect.gen(function* () {
		const tasks = yield* Tasks
		const scheduler = yield* Scheduler
		yield* scheduler.run.pipe(Effect.forkScoped)
		const settle = Effect.fn('PipelineRuntime.settle')(function* (taskId, commandId) {
			const events = yield* tasks.events(taskId, commandId)
			const latest = yield* Stream.runLast(events)
			assert(Option.isSome(latest))
			assert.equal(latest.value.command.delivery._tag, 'Acknowledged')
			assert.equal(latest.value.observation._tag, 'Idle')
			return latest.value
		})

		const request = { kind: 'review', pr: pr.url }
		const first = yield* tasks.submit('fixture-review', request)
		assert.deepEqual((yield* tasks.submit('fixture-review', request)).command.id, first.command.id)
		const taskId = first.task.id
		const reviewed = yield* settle(taskId, first.command.id)
		assert.equal(reviewed.task.submissions._tag, 'Open')
		assert.equal(reviewed.task.placement._tag, 'Assigned')
		const { assignment } = reviewed.task.placement
		assert.deepEqual(assignment, newAssignment(worker, info, taskId))
		assert.deepEqual(reviewed.command.delivery.nativeRef, {
			sessionId: assignment.sessionId,
			messageId: first.command.messageId,
		})
		const initialRequests = sessionRequests(assignment.sessionId)
		assert.equal(initialRequests.length, 2, 'Initial review makes one read and one text step')
		assert.equal(git('-C', assignment.directory, 'rev-parse', 'HEAD'), movedSha)

		phase = 'coordinator resume after native acknowledgement and idle'
		const resumeText = 'PIPELINE_COORDINATOR_RESUME_FIXTURE: continue this conversation.'
		const resume = yield* tasks.resume(taskId, 'fixture-resume', {
			afterCommandId: first.command.id,
			message: resumeText,
		})
		const resumed = yield* settle(taskId, resume.command.id)
		assert.deepEqual(resumed.task.placement, reviewed.task.placement)
		const allRequests = sessionRequests(assignment.sessionId)
		assert.equal(allRequests.length, 3, 'Resume makes one more step in the same session')
		for (const text of [`Pipeline task: ${taskId}.`, readMarker, resumeText])
			assert(conversation(allRequests[2]).includes(text), `Retained conversation lacks ${text}`)
		const history = yield* Effect.promise(() => journal(assignment.sessionId))
		assert.deepEqual(enqueued(history), [first.command.messageId, resume.command.messageId])
		assert.equal(count(history, 'session.created'), 1)

		phase = 'logical close retains the Capsule and native session'
		yield* Effect.promise(() =>
			writeFile(join(assignment.directory, 'unpublished.txt'), 'coordinator unpublished work\n'),
		)
		const closed = yield* tasks.close(taskId)
		assert.equal(closed.submissions._tag, 'Closed')
		const refused = yield* tasks
			.resume(taskId, 'fixture-after-close', { afterCommandId: resume.command.id, message: 'x' })
			.pipe(Effect.flip)
		assert.equal(refused.code, 'task_closed')
		yield* scheduler.tick()
		const interrupt = yield* tasks.interrupt(taskId, 'fixture-interrupt', {
			afterCommandId: resume.command.id,
		})
		const interrupted = yield* settle(taskId, interrupt.command.id)
		assert.deepEqual(interrupted.command.delivery.nativeRef, { sessionId: assignment.sessionId })
		yield* scheduler.tick()
		const view = yield* tasks.get(taskId)
		assert.equal(view.task.submissions._tag, 'Closed')
		assert.deepEqual(
			view.commands.map((command) => command.delivery._tag),
			['Acknowledged', 'Acknowledged', 'Acknowledged'],
		)
		assert.equal(view.observation._tag, 'Idle')
		return { task: view.task, assignment, first, resume }
	}).pipe(Effect.scoped, Effect.timeout('8 minutes'))

	const coordinator = ManagedRuntime.make(services)
	try {
		const result = await coordinator.runPromise(program)
		const source = await runtime.runPromise(pullRequestSource(pr))
		await verifyRetainedAfterClose(worker, result, source, database)
		return result
	} finally {
		await coordinator.dispose()
	}
}

async function verifyRetainedAfterClose(worker, { task, assignment, first, resume }, source, db) {
	phase = 'closed task retains its Capsule, native session, and only dispatch state'
	const identity = sessionIdentity(task, assignment)
	await stat(join(assignment.directory, '.git'))
	assert.equal(
		await readFile(join(assignment.directory, 'unpublished.txt'), 'utf8'),
		'coordinator unpublished work\n',
	)
	await expectRetainedCapsule(identity, source)
	const session = await client().session.get({ sessionID: assignment.sessionId })
	assert.equal(session.location.directory, assignment.directory)
	await call(adapter.requirePlacement(worker, identity))
	await expectPlaced(identity)

	const coordinator = new DatabaseSync(db, { readOnly: true })
	try {
		const commands = coordinator
			.prepare('SELECT id, record FROM dispatch_commands WHERE task_id = ? ORDER BY position')
			.all(task.id)
			.map((row) => JSON.parse(row.record))
		assert.deepEqual(
			commands.map((command) => command.id),
			[first.command.id, resume.command.id, commands[2].id],
		)
		for (const command of commands) {
			assert.equal(command.delivery._tag, 'Acknowledged')
			assert(!('payload' in command.delivery), 'Acknowledged commands must drop their payload')
		}
		assert.deepEqual(
			coordinator.prepare('SELECT task_id FROM dispatch_leases').all(),
			[],
			'Idle native sessions must release dispatch capacity',
		)
		const stored = JSON.stringify(
			['dispatch_tasks', 'dispatch_commands', 'dispatch_keys'].map((table) =>
				coordinator.prepare(`SELECT * FROM ${table}`).all(),
			),
		)
		assert(!stored.includes('Fixture free-form review text'), 'Native outputs stay in OpenCode')
		assert(!stored.includes('PIPELINE_COORDINATOR_RESUME_FIXTURE'), 'Sent prompts are dropped')
	} finally {
		coordinator.close()
	}
}

/** Files below `root` whose bytes contain any of `needles`. */
async function filesContaining(root, needles) {
	const found = []
	for (const entry of await readdir(root, { recursive: true })) {
		const file = join(root, entry)
		if (!(await lstat(file)).isFile()) continue
		const bytes = await readFile(file)
		if (needles.some((needle) => bytes.includes(needle))) found.push(file)
	}
	return found.sort()
}

let watchdog
const abandoned = new Promise((_, reject) => {
	watchdog = setTimeout(
		() => reject(new Error(`The runtime check exceeded ${overallDeadline / 60_000} minutes`)),
		overallDeadline,
	)
})
let passed = false
try {
	await Promise.race([
		abandoned,
		(async () => {
			phase = 'native server startup'
			await start()
			assert.equal((await client().server.info()).version, expectedVersion)
			const { worker, info, movedSha, adapterSession } = await verifyAdapter()
			const coordinator = await verifyCoordinator(worker, info, movedSha)
			phase = 'credentials stay in their host files'
			await stop()
			assert.deepEqual(
				await filesContaining(
					directory,
					[githubToken, ...decoys].map((token) => Buffer.from(token)),
				),
				[hostGhConfig, tokenFile].sort(),
			)
			console.log(
				JSON.stringify({
					status: 'PASS',
					version: expectedVersion,
					modelCalls: modelRequests.length,
					adapterSession,
					coordinatorSession: coordinator.assignment.sessionId,
					capsuleBacked: true,
					sandboxed: true,
					restarted: true,
					resumed: true,
					interrupted: true,
					stoppedInterrupted: true,
					purgedRetained: true,
					workspaceAbsentRetained: true,
					closedRetained: true,
				}),
			)
			passed = true
		})(),
	])
} catch (error) {
	console.error(JSON.stringify({ phase, modelRequests: modelRequests.length, directory }))
	console.error(sanitize(error?.stack ?? error))
	console.error(sanitize(output).slice(-16000))
	process.exitCode = 1
} finally {
	clearTimeout(watchdog)
	releaseFirst.resolve()
	releaseStop.resolve()
	await stop().catch((error) => {
		console.error(sanitize(error))
		process.exitCode = 1
	})
	await runtime.dispose()
	provider.closeAllConnections()
	await new Promise((done) => provider.close(done))
	await closeGitServer()
	if (passed)
		await rm(directory, { recursive: true, force: true }).catch(() =>
			console.error(`Could not remove the fixture directory ${directory}`),
		)
}
// An abandoned step may still hold handles after its resources were released.
if (!passed) process.exit(1)
