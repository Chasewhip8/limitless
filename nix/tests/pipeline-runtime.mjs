import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
	access,
	constants,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	stat,
	writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { delimiter, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { NodeHttpClient, NodeServices } from '@effect/platform-node'
import { OpenCode } from '@opencode/client'
import { Effect, Layer, ManagedRuntime, Option, Schema, Stream } from 'effect'
import { PipelineConfig, PipelineSettings } from '../../packages/pipeline/config.ts'
import { GitHub } from '../../packages/pipeline/github/service.ts'
import { Scheduler, schedulerLayer } from '../../packages/pipeline/scheduler.ts'
import { newAssignment, sessionIdentity } from '../../packages/pipeline/tasks/placement.ts'
import { Tasks, tasksLayer } from '../../packages/pipeline/tasks/service.ts'
import { taskStoreLayer } from '../../packages/pipeline/tasks/store.ts'
import { OpenCodeWorker, openCodeWorkerLayer } from '../../packages/pipeline/worker/service.ts'
import { PrepareInput } from '../../packages/pipeline/workspace/schema.ts'
import { Manifest } from '../../packages/pipeline/workspace/state.ts'

// Bundled by pipeline.nix against the production dispatcher, adapter, and locked dependencies.
const [opencodeExecutable, helperExecutable, expectedVersion, system] = process.argv.slice(2)
assert(opencodeExecutable && helperExecutable && expectedVersion && system)
assert.equal(expectedVersion, '2.2.7', 'Recheck the native contract when upgrading OpenCode')
process.umask(0o077)

function deferred() {
	let resolve
	const promise = new Promise((done) => {
		resolve = done
	})
	return { promise, resolve }
}

async function executable(name) {
	for (const directory of (process.env.PATH ?? '').split(delimiter)) {
		const file = join(directory, name)
		if (
			await access(file, constants.X_OK).then(
				() => true,
				() => false,
			)
		)
			return file
	}
	return undefined
}

const directory = await mkdtemp(join(process.env.TMPDIR ?? '/tmp/opencode', 'pipeline-runtime-'))
for (const name of ['home', 'config', 'data', 'state', 'cache', 'runtime', 'control', 'identity'])
	await mkdir(join(directory, name), { mode: 0o700 })
const home = join(directory, 'home')
const workspaceRoot = join(directory, 'workspaces')
const controlDirectory = join(directory, 'control')
const password = randomUUID()
const credentialFile = join(directory, 'worker-password')
await writeFile(credentialFile, password, { mode: 0o600 })
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
const shell =
	(process.env.SHELL?.startsWith('/') ? process.env.SHELL : undefined) ??
	(await executable('bash')) ??
	'/bin/sh'
const readFileName = 'pipeline-runtime-read.txt'
const readMarker = 'PIPELINE_RUNTIME_TOOL_RESULT_2_2_7'
const readCallId = 'call_pipeline_fixture_read'
const stopMarker = 'PIPELINE_RUNTIME_STOP_FIXTURE'
const fixtureUrl = 'https://github.com/fixture/repository.git'
let phase = 'fixture setup'

// Git fixture: the worker's own global configuration rewrites the canonical GitHub URL.
const gitEnvironment = {
	PATH: process.env.PATH,
	HOME: home,
	XDG_CONFIG_HOME: join(directory, 'config'),
	GIT_CONFIG_NOSYSTEM: '1',
}
const git = (...args) =>
	execFileSync(
		'git',
		[
			'-c',
			'core.hooksPath=/dev/null',
			'-c',
			'user.name=Pipeline Fixture',
			'-c',
			'user.email=fixture@example.invalid',
			...args,
		],
		{ env: gitEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
	).trim()
const seed = join(directory, 'seed')
const remote = join(directory, 'fixture.git')
git('init', '--initial-branch', 'review-fixture', seed)
await writeFile(join(seed, 'review.txt'), 'base\n')
await writeFile(join(seed, readFileName), `${readMarker}\n`)
git('-C', seed, 'add', 'review.txt', readFileName)
git('-C', seed, 'commit', '--no-gpg-sign', '-m', 'base')
const baseSha = git('-C', seed, 'rev-parse', 'HEAD')
await writeFile(join(seed, 'review.txt'), 'head\n')
git('-C', seed, 'commit', '--no-gpg-sign', '-am', 'head')
const headSha = git('-C', seed, 'rev-parse', 'HEAD')
git('clone', '--bare', '--no-hardlinks', seed, remote)
git('--git-dir', remote, 'update-ref', 'refs/pull/1/head', headSha)
git('config', '--file', join(home, '.gitconfig'), `url.${remote}.insteadOf`, fixtureUrl)

async function movePullRequestHead() {
	await writeFile(join(seed, 'review.txt'), 'moved\n')
	git('-C', seed, 'commit', '--no-gpg-sign', '-am', 'moved')
	const moved = git('-C', seed, 'rev-parse', 'HEAD')
	git('-C', seed, 'push', '--quiet', remote, 'review-fixture')
	git('--git-dir', remote, 'update-ref', 'refs/pull/1/head', moved)
	return moved
}

// Loopback model: one genuine read step per session, then free-form assistant text.
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
	const hasReadResult = messages.some(
		(message) => message.role === 'tool' && message.tool_call_id === readCallId,
	)
	if (!hasReadResult) {
		// https://github.com/anomalyco/opencode/blob/fedc6f208aa2bd54c1019227214568083f6380ad/packages/core/src/tool/plugin/read.ts
		const tool = body.tools?.find((entry) => entry.function?.name === 'read')
		assert(tool, 'Pinned native read tool must be offered to the review agent')
		assert(tool.function.parameters.required.includes('path'))
		if (modelRequests.length === 1) {
			firstStarted.resolve()
			await releaseFirst.promise
		}
		return {
			tool_calls: [
				{
					index: 0,
					id: readCallId,
					type: 'function',
					function: {
						name: 'read',
						arguments: JSON.stringify({ path: readFileName, offset: 1, limit: 20 }),
					},
				},
			],
		}
	}
	const results = messages.filter(
		(message) => message.role === 'tool' && message.tool_call_id === readCallId,
	)
	assert.equal(results.length, 1, 'The conversation must contain exactly one genuine read result')
	assert(JSON.stringify(results[0].content).includes(readMarker))
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
				permissions: [{ action: 'read', resource: readFileName, effect: 'allow' }],
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
				PATH: process.env.PATH,
				SHELL: shell,
				HOME: home,
				XDG_CONFIG_HOME: join(directory, 'config'),
				XDG_DATA_HOME: join(directory, 'data'),
				XDG_STATE_HOME: join(directory, 'state'),
				XDG_CACHE_HOME: join(directory, 'cache'),
				XDG_RUNTIME_DIR: join(directory, 'runtime'),
				GIT_CONFIG_NOSYSTEM: '1',
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
	exited = new Promise((done, reject) => {
		server.once('exit', (code, signal) => {
			done({ code, signal })
			ready.resolve(undefined)
		})
		server.once('error', reject)
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

async function journal(sessionID) {
	const entries = []
	for await (const entry of client().experimental.session.log({ sessionID, follow: false })) {
		entries.push(entry)
		if (entry.type === 'log.synced') break
	}
	assert.equal(entries.at(-1)?.type, 'log.synced', 'Native log ended before its durable watermark')
	return entries
}

async function nativeShellOutputs() {
	const root = join(directory, 'data')
	const files = await readdir(root, { recursive: true })
	return Promise.all(
		files
			.filter((file) => /(^|\/)sh_[0-9a-f]{12}[^/]*\.out$/.test(file))
			.map((file) => readFile(join(root, file), 'utf8')),
	)
}

const count = (entries, type) => entries.filter((entry) => entry.type === type).length
const enqueued = (entries) =>
	entries
		.filter((entry) => entry.type === 'session.inbox.enqueued')
		.map((entry) => entry.data.inboxID)
const sessionRequests = (sessionId) =>
	modelRequests.filter((request) => request.sessionId === sessionId)
const conversation = (request) => JSON.stringify(request.messages)

function runHelper(request) {
	const encoded = Buffer.from(JSON.stringify(request)).toString('base64url')
	return JSON.parse(
		execFileSync(helperExecutable, ['workspace', '--root', workspaceRoot, '--request', encoded], {
			env: gitEnvironment,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		}),
	)
}

const runtime = ManagedRuntime.make(
	openCodeWorkerLayer.pipe(
		Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
	),
)
const call = (effect) => runtime.runPromise(effect.pipe(Effect.timeout('60 seconds')))
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
	workspaceRoot,
	helperExecutable,
	system,
	capacity: 1,
	openCodeVersion: expectedVersion,
})

async function waitForObservation(worker, identity, messageId, accepted) {
	const deadline = Date.now() + 30000
	for (;;) {
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

async function verifyAdapter() {
	phase = 'worker readiness and helper protocol through the native shell'
	let worker = workerAt(base)
	await call(adapter.ready(worker))
	const taskId = randomUUID()
	const assignment = newAssignment(worker, taskId)
	const identity = {
		taskId,
		sessionId: assignment.sessionId,
		directory: assignment.directory,
		pr: 'https://github.com/fixture/repository/pull/1',
	}
	const input = Schema.decodeUnknownSync(PrepareInput)({
		taskId,
		repository: 'fixture/repository',
		sourceRepository: 'fixture/repository',
		prNumber: 1,
		headRef: 'review-fixture',
		headSha,
		baseSha,
	})

	phase = 'production prepare through the native shell'
	const prepared = await call(adapter.prepare(worker, assignment, input))
	assert.deepEqual(prepared, { _tag: 'Ready', taskId, directory: assignment.directory })
	const manifest = Schema.decodeUnknownSync(Manifest)(
		JSON.parse(await readFile(join(workspaceRoot, taskId, 'manifest.json'), 'utf8')),
	)
	assert.deepEqual(manifest.input, input)
	assert.deepEqual(manifest.status, prepared)
	assert.equal(git('-C', identity.directory, 'rev-parse', 'HEAD'), headSha)
	assert.equal(git('-C', identity.directory, 'rev-parse', '--is-shallow-repository'), 'false')
	assert.equal(git('-C', identity.directory, 'config', 'remote.origin.url'), fixtureUrl)
	git('-C', identity.directory, 'cat-file', '-e', `${baseSha}^{commit}`)
	assert.deepEqual(await call(adapter.prepare(worker, assignment, input)), prepared)
	// OpenCode lists only running shells; exited native shell output remains in its data directory.
	const shellOutputs = await nativeShellOutputs()
	assert.equal(shellOutputs.filter((text) => text === '{"protocolVersion":2}\n').length, 1)
	assert.equal(
		shellOutputs.filter((text) => text === `${JSON.stringify(prepared)}\n`).length,
		2,
		'Each adapter prepare must run the helper through one native shell',
	)

	phase = 'retained Ready checkout ignores a moved remote head'
	await writeFile(join(identity.directory, 'unpublished.txt'), 'retained unpublished work\n')
	git('-C', identity.directory, 'commit', '--no-gpg-sign', '--allow-empty', '-m', 'local work')
	const localHead = git('-C', identity.directory, 'rev-parse', 'HEAD')
	const movedSha = await movePullRequestHead()
	assert.deepEqual(runHelper({ operation: 'prepare', input }), prepared)
	assert.deepEqual(runHelper({ operation: 'inspect', taskId }), prepared)
	assert.equal(git('-C', identity.directory, 'rev-parse', 'HEAD'), localHead)
	assert.equal(
		await readFile(join(identity.directory, 'unpublished.txt'), 'utf8'),
		'retained unpublished work\n',
	)

	phase = 'ordinary directory session creation'
	await call(adapter.createSession(worker, identity))
	await call(adapter.createSession(worker, identity))
	await call(adapter.requireSession(worker, identity))
	const session = await client().session.get({ sessionID: identity.sessionId })
	assert.equal(session.id, identity.sessionId)
	assert.equal(session.location.directory, identity.directory)
	assert.equal(session.agent, 'review')
	assert.deepEqual(session.metadata, { pipeline: { taskId, pr: identity.pr } })
	assert(!session.permissions?.length, 'The adapter must not force session permissions')
	assert.deepEqual(await call(adapter.observe(worker, identity)), { _tag: 'Idle' })

	phase = 'initial admission, native running view, and read-only reconciliation'
	const firstMessage = `msg_pipeline${randomUUID().replaceAll('-', '')}`
	const firstPrompt = 'PIPELINE_RUNTIME_REVIEW_FIXTURE: read the fixture file and reply.'
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
	assert.equal(sessionRequests(identity.sessionId).length, 2, 'One read step and one text step')
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
	assert.equal(count(initial, 'session.tool.success'), 1)
	assert.equal(count(initial, 'session.execution.succeeded'), 1)

	phase = 'native restart adopts retained history without recreating sessions'
	await stop()
	await start()
	worker = workerAt(base)
	await call(adapter.ready(worker))
	await call(adapter.requireSession(worker, identity))
	assert.deepEqual(await call(adapter.observe(worker, identity, firstMessage)), { _tag: 'Idle' })
	assert.deepEqual(await call(adapter.findAdmission(worker, identity, firstMessage, firstPrompt)), {
		sessionId: identity.sessionId,
		messageId: firstMessage,
	})
	const unknownSession = {
		...identity,
		sessionId: `ses_pipeline${randomUUID().replaceAll('-', '')}`,
	}
	await rejected(adapter.requireSession(worker, unknownSession))
	await assert.rejects(client().session.get({ sessionID: unknownSession.sessionId }))

	phase = 'resume in the same native session and directory'
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

	phase = 'native interrupt receipt and observations'
	const stopMessage = `msg_pipeline${randomUUID().replaceAll('-', '')}`
	await call(adapter.admit(worker, identity, stopMessage, `${stopMarker}: wait for interruption.`))
	await stopStarted.promise
	assert.equal(
		(await waitForObservation(worker, identity, stopMessage, ['Running']))._tag,
		'Running',
	)
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
	return { worker, movedSha, adapterSession: identity.sessionId }
}

async function verifyCoordinator(worker, movedSha) {
	phase = 'coordinator submit through production tasks, scheduler, and adapter'
	const database = join(directory, 'coordinator.sqlite')
	const pr = {
		url: 'https://github.com/fixture/repository/pull/1',
		repository: 'fixture/repository',
		sourceRepository: 'fixture/repository',
		repositoryId: 1,
		sourceRepositoryId: 1,
		number: 1,
		headRef: 'review-fixture',
		headSha: movedSha,
		baseSha,
	}
	const settings = Schema.decodeUnknownSync(PipelineSettings)({
		host: '127.0.0.1',
		port: 4848,
		database,
		apiTokenFile: credentialFile,
		githubTokenFile: null,
		pollIntervalMs: 100,
		queueTimeoutMs: 60000,
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
		assert.deepEqual(assignment, newAssignment(worker, taskId))
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

		phase = 'logical close retains checkout and native session'
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
		return { taskId, assignment, first, resume }
	}).pipe(Effect.scoped, Effect.timeout('120 seconds'))

	const runtime = ManagedRuntime.make(services)
	try {
		const result = await runtime.runPromise(program)
		await verifyRetainedAfterClose(worker, result, database)
		return result
	} finally {
		await runtime.dispose()
	}
}

async function verifyRetainedAfterClose(worker, { taskId, assignment, first, resume }, database) {
	phase = 'closed task retains files, native session, and only dispatch state'
	await stat(join(assignment.directory, '.git'))
	assert.equal(
		await readFile(join(assignment.directory, 'unpublished.txt'), 'utf8'),
		'coordinator unpublished work\n',
	)
	assert.deepEqual(runHelper({ operation: 'inspect', taskId }), {
		_tag: 'Ready',
		taskId,
		directory: assignment.directory,
	})
	const session = await client().session.get({ sessionID: assignment.sessionId })
	assert.equal(session.location.directory, assignment.directory)
	const task = { id: taskId, request: { pr: 'https://github.com/fixture/repository/pull/1' } }
	await call(adapter.requireSession(worker, sessionIdentity(task, assignment)))

	const db = new DatabaseSync(database, { readOnly: true })
	try {
		const commands = db
			.prepare('SELECT id, record FROM dispatch_commands WHERE task_id = ? ORDER BY position')
			.all(taskId)
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
			db.prepare('SELECT task_id FROM dispatch_leases').all(),
			[],
			'Idle native sessions must release dispatch capacity',
		)
		const stored = JSON.stringify(
			['dispatch_tasks', 'dispatch_commands', 'dispatch_keys'].map((table) =>
				db.prepare(`SELECT * FROM ${table}`).all(),
			),
		)
		assert(!stored.includes('Fixture free-form review text'), 'Native outputs stay in OpenCode')
		assert(!stored.includes('PIPELINE_COORDINATOR_RESUME_FIXTURE'), 'Sent prompts are dropped')
	} finally {
		db.close()
	}
}

try {
	phase = 'native server startup'
	await start()
	assert.equal((await client().server.info()).version, expectedVersion)
	const { worker, movedSha, adapterSession } = await verifyAdapter()
	const coordinator = await verifyCoordinator(worker, movedSha)
	console.log(
		JSON.stringify({
			status: 'PASS',
			version: expectedVersion,
			modelCalls: modelRequests.length,
			adapterSession,
			coordinatorSession: coordinator.assignment.sessionId,
			restarted: true,
			resumed: true,
			interrupted: true,
			closedRetained: true,
		}),
	)
} catch (error) {
	console.error(JSON.stringify({ phase, modelRequests: modelRequests.length }))
	const diagnostic = output
		.replaceAll(password, '[redacted]')
		.replaceAll(authorization, '[redacted]')
	console.error(error)
	console.error(diagnostic.slice(-16000))
	process.exitCode = 1
} finally {
	releaseFirst.resolve()
	releaseStop.resolve()
	await stop()
	await runtime.dispose()
	provider.closeAllConnections()
	await new Promise((done) => provider.close(done))
}
