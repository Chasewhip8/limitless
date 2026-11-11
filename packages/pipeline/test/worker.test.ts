import { Agent } from '@opencode/client/effect'
import { Effect, Fiber, FileSystem, Layer, Schema, Stream } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { TestClock } from 'effect/testing'
import { expect, test } from 'vitest'
import type { SessionIdentity, Worker } from '../worker/schema'
import { OpenCodeWorker, openCodeWorkerLayer } from '../worker/service'

const identity: SessionIdentity = {
	taskId: '73c69c86-76ad-49b3-b658-7c76e018953d',
	sessionId: 'ses_task',
	directory: '/work/task',
	pr: 'https://github.com/owner/repo/pull/1',
}
const worker: Worker = {
	id: 'worker-a',
	url: 'https://worker.example',
	credentialFile: '/runtime/password',
	workspaceRoot: '/work',
	helperExecutable: '/nix/store/helper/bin/pipeline',
	system: 'x86_64-linux',
	capacity: 1,
	openCodeVersion: '2.2.7',
}
const messageId = 'msg_request'
const session = () => ({
	id: identity.sessionId,
	projectID: 'global',
	agent: 'review',
	cost: 0,
	tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
	time: { created: 0, updated: 0 },
	location: { directory: identity.directory },
	metadata: { pipeline: { taskId: identity.taskId, pr: identity.pr } },
})
const item = (id = messageId, text = 'exact prompt') => ({
	id,
	sessionID: identity.sessionId,
	type: 'user',
	payload: { text },
	delivery: 'queue',
	time: { created: 0 },
})
type Fact = { type: string; data: Record<string, unknown> }
const admitted = (id = messageId, text = 'exact prompt'): Fact => ({
	type: 'session.inbox.enqueued',
	data: { inboxID: id, item: { type: 'user', payload: { text }, delivery: 'queue' } },
})
const frame = (value: unknown) => `event: message\ndata: ${JSON.stringify(value)}\n\n`

function fixture() {
	const calls: { method: string; url: URL; body: unknown; headers: Headers; redirect: unknown }[] =
		[]
	const state = {
		session: session() as ReturnType<typeof session> | undefined,
		inbox: [] as ReturnType<typeof item>[],
		messages: new Map<
			string,
			{ id: string; type: 'user'; text: string; time: { created: number } }
		>(),
		log: [] as Fact[],
		active: {} as Record<string, { type: 'running' }>,
		permissions: [] as unknown[],
		forms: [] as unknown[],
		jobs: [] as unknown[],
		version: '2.2.7',
		eventBatch: undefined as ReadonlyArray<unknown> | undefined,
		protocolVersion: 2,
		review: true,
		eventCancellations: 0,
		helperInput: undefined as
			| { command: string; cwd: string; metadata: Record<string, unknown> }
			| undefined,
		override: undefined as
			| ((url: URL, init: RequestInit, body: unknown) => Response | undefined)
			| undefined,
	}
	const location = { directory: '/control' }
	const helper = () => ({
		id: 'sh_helper',
		status: 'exited',
		command: state.helperInput?.command ?? '',
		cwd: '/control',
		shell: '/bin/sh',
		file: '/output',
		metadata: state.helperInput?.metadata ?? {},
		time: { started: 0, completed: 1 },
		exit: 0,
	})
	const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = new URL(String(input))
		const method = init.method ?? 'GET'
		const body = init.body ? JSON.parse(Buffer.from(init.body as Uint8Array).toString()) : undefined
		calls.push({ method, url, body, headers: new Headers(init.headers), redirect: init.redirect })
		const override = state.override?.(url, init, body)
		if (override) return override
		if (url.pathname === '/api/info')
			return Response.json({ version: state.version, pid: 1, urls: [], paths: { tmp: '/fixture' } })
		if (url.pathname === '/api/agent')
			return Response.json({
				location,
				data: state.review
					? [Schema.encodeSync(Agent.Info)(Agent.Info.default(Agent.ID.make('review')))]
					: [],
			})
		if (url.pathname === '/api/location')
			return Response.json({
				...location,
				project: { id: 'global', directory: '/control', canonical: '/control' },
			})
		if (url.pathname === '/api/event' && state.eventBatch !== undefined) {
			return new Response(
				[{ id: 'evt_connected', type: 'server.connected', data: {} }, ...state.eventBatch]
					.map(frame)
					.join(''),
				{ headers: { 'content-type': 'text/event-stream' } },
			)
		}
		if (url.pathname === '/api/event')
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								frame({ id: 'evt_connected', type: 'server.connected', data: {} }),
							),
						)
					},
					cancel() {
						state.eventCancellations++
					},
				}),
				{ headers: { 'content-type': 'text/event-stream' } },
			)
		if (url.pathname === '/api/shell' && method === 'GET')
			return Response.json({ location, data: [] })
		if (url.pathname === '/api/shell' && method === 'POST') {
			state.helperInput = body
			return Response.json({ location, data: helper() })
		}
		if (url.pathname === '/api/shell/sh_helper') return Response.json({ location, data: helper() })
		if (url.pathname === '/api/shell/sh_helper/output') {
			const value = state.helperInput?.command.endsWith(' protocol')
				? { protocolVersion: state.protocolVersion }
				: { _tag: 'Ready', taskId: identity.taskId, directory: identity.directory }
			const output = JSON.stringify(value)
			return Response.json({
				location,
				data: { output, cursor: output.length, size: output.length, truncated: false },
			})
		}
		if (url.pathname === '/api/session' && method === 'POST')
			return Response.json({ data: state.session })
		if (url.pathname === '/api/session/active') return Response.json({ data: state.active })
		if (url.pathname === '/api/experimental/job') return Response.json({ data: state.jobs })
		if (url.pathname.endsWith('/log')) {
			const entries = state.log.map((entry, seq) => ({
				id: `evt_${seq}`,
				created: seq,
				type: entry.type,
				durable: { aggregateID: identity.sessionId, seq, version: 1 },
				data: { sessionID: identity.sessionId, ...entry.data },
			}))
			return new Response(
				[
					...entries,
					{
						type: 'log.synced',
						aggregateID: identity.sessionId,
						...(entries.length === 0 ? {} : { seq: entries.length - 1 }),
					},
				]
					.map(frame)
					.join(''),
				{ headers: { 'content-type': 'text/event-stream' } },
			)
		}
		const route = url.pathname.match(/^\/api\/session\/([^/]+)(.*)$/)
		if (route) {
			const sessionID = route[1]
			const suffix = route[2]
			if (!state.session)
				return Response.json(
					{ _tag: 'SessionNotFoundError', sessionID, message: 'Missing session' },
					{ status: 404 },
				)
			if (!suffix) return Response.json({ data: state.session })
			if (suffix === '/inbox') return Response.json({ data: state.inbox })
			if (suffix === '/permission') return Response.json({ data: state.permissions })
			if (suffix === '/form') return Response.json({ data: state.forms })
			if (suffix?.startsWith('/message/')) {
				const id = suffix.slice('/message/'.length)
				const message = state.messages.get(id)
				return message
					? Response.json({ data: message })
					: Response.json(
							{ _tag: 'MessageNotFoundError', sessionID, messageID: id, message: 'Missing input' },
							{ status: 404 },
						)
			}
			if (suffix === '/prompt') {
				state.inbox.push(item(body.id, body.text))
				state.log.push(admitted(body.id, body.text))
				return Response.json({ data: item(body.id, body.text) })
			}
			if (suffix === '/interrupt') return Response.json({ interrupted: true })
		}
		throw new Error(`Unexpected request ${method} ${url.pathname}`)
	}
	const layer = openCodeWorkerLayer.pipe(
		Layer.provide(
			Layer.merge(
				FetchHttpClient.layer,
				Layer.succeed(
					FileSystem.FileSystem,
					FileSystem.makeNoop({
						readFileString: () => Effect.succeed(' password with spaces \r\n'),
					}),
				),
			),
		),
	)
	const program = <A, E>(operation: (service: OpenCodeWorker['Service']) => Effect.Effect<A, E>) =>
		Effect.gen(function* () {
			const service = yield* OpenCodeWorker
			return yield* operation(service)
		}).pipe(
			Effect.provide(layer),
			Effect.provideService(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch),
		)
	return {
		state,
		calls,
		run: <A, E>(operation: (service: OpenCodeWorker['Service']) => Effect.Effect<A, E>) =>
			Effect.runPromise(program(operation)),
		runTimed: <A, E>(
			operation: (service: OpenCodeWorker['Service']) => Effect.Effect<A, E>,
			millis: number,
		) =>
			Effect.runPromise(
				Effect.gen(function* () {
					const fiber = yield* program(operation).pipe(Effect.forkChild)
					yield* TestClock.adjust(millis)
					return yield* Fiber.join(fiber)
				}).pipe(Effect.provide(TestClock.layer())),
			),
	}
}

test('native enrollment checks the helper and closes its event subscription without status polling', async () => {
	const f = fixture()
	await f.run((service) => service.ready(worker))
	expect(f.state.eventCancellations).toBe(1)
	expect(f.calls.filter((call) => call.url.pathname === '/api/shell/sh_helper')).toHaveLength(1)
	expect(f.calls.every((call) => call.url.origin === worker.url && call.redirect === 'error')).toBe(
		true,
	)
	expect(f.calls[0]?.headers.get('authorization')).toBe(
		`Basic ${Buffer.from('opencode: password with spaces ').toString('base64')}`,
	)
	f.state.protocolVersion = 1
	await expect(f.run((service) => service.ready(worker))).rejects.toMatchObject({
		code: 'incompatible',
	})
})

test('helper exits, including failed protocol probes, do not wake the task scheduler', async () => {
	const f = fixture()
	f.state.eventBatch = [
		{
			id: 'evt_helper',
			created: 0,
			type: 'shell.exited',
			location: { directory: '/control' },
			data: { id: 'sh_helper', status: 'exited', exit: 0 },
		},
		{
			id: 'evt_failed_helper',
			created: 1,
			type: 'shell.exited',
			location: { directory: '/control' },
			data: { id: 'sh_failed_helper', status: 'exited', exit: 1 },
		},
		{
			id: 'evt_native',
			created: 2,
			type: 'session.execution.succeeded',
			durable: { aggregateID: identity.sessionId, seq: 0, version: 1 },
			data: { sessionID: identity.sessionId },
		},
	]
	const changes = await f.run((service) => service.watch(worker).pipe(Stream.runCollect))
	expect(changes).toHaveLength(2)
})

test('credentialed transport rejects insecure/non-origin targets and redirects', async () => {
	const f = fixture()
	for (const url of [
		'http://worker.example',
		`${worker.url}/path`,
		'https://user:password@worker.example',
	]) {
		await expect(f.run((service) => service.ready({ ...worker, url }))).rejects.toMatchObject({
			code: 'incompatible',
		})
	}
	expect(f.calls).toHaveLength(0)
	f.state.override = () =>
		new Response(null, { status: 302, headers: { location: 'https://other.example' } })
	await expect(f.run((service) => service.ready(worker))).rejects.toBeDefined()
	expect(f.calls).toHaveLength(1)
})

test('request deadlines include the entire response body', async () => {
	const f = fixture()
	f.state.override = () =>
		new Response(new ReadableStream(), { headers: { 'content-type': 'application/json' } })
	await expect(f.runTimed((service) => service.ready(worker), 15001)).rejects.toMatchObject({
		code: 'unavailable',
	})
})

test('initial creation uses an ordinary directory session without native permission or workspace policy', async () => {
	const f = fixture()
	await f.run((service) => service.createSession(worker, identity))
	expect(f.calls[0]?.body).toMatchObject({
		id: identity.sessionId,
		location: { directory: identity.directory },
		agent: 'review',
		metadata: { pipeline: { taskId: identity.taskId, pr: identity.pr } },
	})
	expect(f.calls[0]?.headers.has('x-pipeline-workspace-id')).toBe(false)
	f.state.session = undefined
	await expect(f.run((service) => service.requireSession(worker, identity))).rejects.toBeDefined()
	expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
})

test('checkout preparation runs only the idempotent helper in the server control directory', async () => {
	const f = fixture()
	const input = {
		taskId: identity.taskId,
		repository: 'owner/repo',
		sourceRepository: 'owner/repo',
		prNumber: 1,
		headRef: 'feature',
		headSha: 'a'.repeat(40),
		baseSha: 'b'.repeat(40),
	}
	expect(await f.run((service) => service.prepare(worker, identity, input))).toMatchObject({
		_tag: 'Ready',
		directory: identity.directory,
	})
	expect(f.state.helperInput?.cwd).toBe('/control')
	expect(f.state.helperInput?.command).toContain(" workspace --root '/work' --request '")
	expect(f.state.helperInput?.metadata).toEqual({
		pipelineTaskId: identity.taskId,
		pipelineWorkerId: worker.id,
	})
})

test('a lost prompt response is recovered by reading OpenCode, never by another prompt', async () => {
	const f = fixture()
	f.state.override = (url) => {
		if (!url.pathname.endsWith('/prompt')) return undefined
		f.state.inbox = [item()]
		return new Response(null, { status: 503 })
	}
	await expect(
		f.run((service) => service.admit(worker, identity, messageId, 'exact prompt')),
	).rejects.toBeDefined()
	f.state.override = undefined
	expect(
		await f.run((service) => service.findAdmission(worker, identity, messageId, 'exact prompt')),
	).toEqual({ sessionId: identity.sessionId, messageId })
	expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
})

test('delivered and cancelled inputs remain positive admission evidence without a mirrored execution journal', async () => {
	const f = fixture()
	f.state.messages.set(messageId, {
		id: messageId,
		type: 'user',
		text: 'exact prompt',
		time: { created: 0 },
	})
	expect(
		await f.run((service) => service.findAdmission(worker, identity, messageId, 'exact prompt')),
	).toEqual({ sessionId: identity.sessionId, messageId })
	f.state.messages.clear()
	f.state.log = [admitted(), { type: 'session.inbox.cancelled', data: { inboxID: messageId } }]
	expect(
		await f.run((service) => service.findAdmission(worker, identity, messageId, 'exact prompt')),
	).toEqual({ sessionId: identity.sessionId, messageId })
	expect(await f.run((service) => service.observe(worker, identity, messageId))).toEqual({
		_tag: 'InputCancelled',
	})
	expect(f.calls.some((call) => call.method === 'POST')).toBe(false)
})

test('missing input is not acknowledged and idle cannot finish a wait before target delivery', async () => {
	const f = fixture()
	expect(
		await f.run((service) => service.findAdmission(worker, identity, messageId, 'exact prompt')),
	).toBeUndefined()
	expect(await f.run((service) => service.observe(worker, identity, messageId))).toEqual({
		_tag: 'NotObserved',
	})
	expect(f.calls.every((call) => call.method === 'GET')).toBe(true)
})

test('matching native IDs with changed payloads are not accepted as this command', async () => {
	const f = fixture()
	f.state.inbox = [item(messageId, 'different')]
	await expect(
		f.run((service) => service.findAdmission(worker, identity, messageId, 'exact prompt')),
	).rejects.toMatchObject({ code: 'ownership' })
	f.state.override = (url) =>
		url.pathname.endsWith('/prompt')
			? Response.json({ data: item(messageId, 'different') })
			: undefined
	await expect(
		f.run((service) => service.admit(worker, identity, messageId, 'exact prompt')),
	).rejects.toMatchObject({ code: 'ownership' })
})

test('native observations expose pending input, activity, requests and idle without a review result', async () => {
	const f = fixture()
	f.state.inbox = [item()]
	expect(await f.run((service) => service.observe(worker, identity, messageId))).toEqual({
		_tag: 'Pending',
		messageIds: [messageId],
	})
	f.state.active = { [identity.sessionId]: { type: 'running' } }
	expect(await f.run((service) => service.observe(worker, identity, messageId))).toEqual({
		_tag: 'Running',
		backgroundJobs: 0,
	})
	f.state.permissions = [
		{ id: 'per_input', sessionID: identity.sessionId, action: 'shell', resources: ['test'] },
	]
	expect(await f.run((service) => service.observe(worker, identity, messageId))).toEqual({
		_tag: 'NeedsInput',
		permissionIds: ['per_input'],
		formIds: [],
	})
	f.state.permissions = []
	f.state.active = {}
	f.state.inbox = []
	f.state.messages.set(messageId, {
		id: messageId,
		type: 'user',
		text: 'exact prompt',
		time: { created: 0 },
	})
	expect(await f.run((service) => service.observe(worker, identity, messageId))).toEqual({
		_tag: 'Idle',
	})
})

test('interrupt returns only a native receipt and neither cancels inbox items nor deletes shells', async () => {
	const f = fixture()
	f.state.active = { [identity.sessionId]: { type: 'running' } }
	expect(await f.run((service) => service.interrupt(worker, identity))).toEqual({
		sessionId: identity.sessionId,
	})
	expect(f.calls.map((call) => [call.method, call.url.pathname])).toEqual([
		['POST', `/api/session/${identity.sessionId}/interrupt`],
	])
	expect(await f.run((service) => service.observe(worker, identity))).toEqual({
		_tag: 'Running',
		backgroundJobs: 0,
	})
})
