import { Agent } from '@opencode/client/effect'
import { Effect, Fiber, FileSystem, Layer, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { TestClock } from 'effect/testing'
import { expect, test } from 'vitest'
import type { SessionIdentity, Worker } from '../worker/schema'
import { OpenCodeWorker, openCodeWorkerLayer } from '../worker/service'
import { pullRequestSource } from '../worker/source'

const identity: SessionIdentity = {
	taskId: '73c69c86-76ad-49b3-b658-7c76e018953d',
	storageId: 'storage-a',
	workspaceId: 'wrk_pipeline73c69c8676ad49b3b6587c76e018953d',
	sessionId: 'ses_task',
	directory: '/work/wrk_pipeline73c69c8676ad49b3b6587c76e018953d/checkout',
}
const worker: Worker = {
	id: 'worker-a',
	url: 'https://worker.example',
	credentialFile: '/runtime/password',
	controlDirectory: '/control',
	system: 'x86_64-linux',
	capacity: 1,
	openCodeVersion: '2.2.7',
}
const host = { version: 1, storageId: identity.storageId, checkoutRoot: '/work' }
const source = {
	repository: 'fork/repo',
	ref: 'feature',
	branch: 'feature',
	commit: 'a'.repeat(40),
	upstream: { repository: 'owner/repo', commits: ['b'.repeat(40)] },
	remoteRefs: [
		{ repository: 'owner/repo', ref: 'refs/pull/1/head', commit: 'a'.repeat(40) },
		{ repository: 'fork/repo', ref: 'refs/heads/feature', commit: 'a'.repeat(40) },
	],
}
const pr = 'https://github.com/owner/repo/pull/1'
const messageId = 'msg_request'
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
type RpcFailure = { type: string; message: string; data?: unknown }
type Call = { method: string; url: URL; body: unknown; headers: Headers; redirect: unknown }
const rpcMethod = (call: Call) => call.url.pathname.match(/^\/api\/rpc\/capsule\/(\w+)$/)?.[1]
const nativeWrites = (calls: ReadonlyArray<Call>) =>
	calls.filter((call) => call.method !== 'GET' && rpcMethod(call) === undefined)

function fixture() {
	const calls: Call[] = []
	const state = {
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
		review: true,
		eventCancellations: 0,
		placed: {
			workspaceId: identity.workspaceId,
			sessionId: identity.sessionId,
			directory: identity.directory,
			capsulePhase: 'ready',
			workspaceState: 'bound',
		},
		rpcFailures: {} as Partial<Record<string, RpcFailure>>,
		override: undefined as
			| ((url: URL, init: RequestInit, body: unknown) => Response | Promise<undefined> | undefined)
			| undefined,
	}
	const location = { directory: '/control' }
	const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = new URL(String(input))
		const method = init.method ?? 'GET'
		const body = init.body ? JSON.parse(Buffer.from(init.body as Uint8Array).toString()) : undefined
		calls.push({ method, url, body, headers: new Headers(init.headers), redirect: init.redirect })
		const override = await state.override?.(url, init, body)
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
		const rpc = url.pathname.match(/^\/api\/rpc\/([^/]+)\/([^/]+)$/)
		if (rpc && method === 'POST') {
			// Capsule registers its RPC only in the host's control location.
			const registered =
				rpc[1] === 'capsule' && url.searchParams.get('location[directory]') === location.directory
			const failure = registered
				? state.rpcFailures[rpc[2] ?? '']
				: { type: 'rpc.unavailable', message: `RPC is unavailable: ${rpc[1]}` }
			if (failure) return Response.json({ _tag: 'RpcError', ...failure }, { status: 400 })
			const { workspaceId, sessionId, directory } = state.placed
			const outputs: Record<string, unknown> = {
				info: host,
				prepareSession: { workspaceId, sessionId, directory },
				getSession: state.placed,
			}
			return Response.json({ output: outputs[rpc[2] ?? ''] })
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
	/** Holds the first matching request until the test clock has advanced. */
	const hold = (pathname: string) => {
		let release = () => {}
		const requested = new Promise<void>((resolve) => {
			state.override = (url) => {
				if (url.pathname !== pathname) return undefined
				resolve()
				return new Promise<undefined>((settle) => {
					release = () => settle(undefined)
				})
			}
		})
		return { requested, release: () => release() }
	}
	return {
		state,
		calls,
		hold,
		run: <A, E>(operation: (service: OpenCodeWorker['Service']) => Effect.Effect<A, E>) =>
			Effect.runPromise(program(operation)),
		runTimed: <A, E>(
			operation: (service: OpenCodeWorker['Service']) => Effect.Effect<A, E>,
			millis: number,
			held?: { requested: Promise<void>; release: () => void },
		) =>
			Effect.runPromise(
				Effect.gen(function* () {
					const fiber = yield* program(operation).pipe(Effect.forkChild)
					if (held !== undefined) yield* Effect.promise(() => held.requested)
					yield* TestClock.adjust(millis)
					held?.release()
					return yield* Fiber.join(fiber)
				}).pipe(Effect.provide(TestClock.layer())),
			),
	}
}

test('enrollment reads Capsule host info at the control directory without mutating the worker', async () => {
	const f = fixture()
	expect(await f.run((service) => service.ready(worker))).toEqual(host)
	expect(f.calls.map(rpcMethod).filter((method) => method !== undefined)).toEqual(['info'])
	expect(nativeWrites(f.calls)).toEqual([])
	expect(
		f.calls
			.filter((call) => call.url.pathname !== '/api/info')
			.map((call) => call.url.searchParams.get('location[directory]')),
	).toEqual([worker.controlDirectory, worker.controlDirectory])
	expect(f.calls.every((call) => call.url.origin === worker.url && call.redirect === 'error')).toBe(
		true,
	)
	expect(f.calls[0]?.headers.get('authorization')).toBe(
		`Basic ${Buffer.from('opencode: password with spaces ').toString('base64')}`,
	)
})

test('enrollment refuses a mismatched OpenCode, a missing review agent, or a cold Capsule registration', async () => {
	const f = fixture()
	f.state.rpcFailures.info = { type: 'rpc.unavailable', message: 'RPC is unavailable: capsule' }
	await expect(f.run((service) => service.ready(worker))).rejects.toMatchObject({
		code: 'unavailable',
	})
	await expect(
		f.run((service) => service.ready({ ...worker, controlDirectory: '/elsewhere' })),
	).rejects.toMatchObject({ code: 'unavailable' })
	f.state.rpcFailures = {}
	f.state.review = false
	await expect(f.run((service) => service.ready(worker))).rejects.toMatchObject({
		code: 'incompatible',
	})
	f.state.version = '2.2.6'
	await expect(f.run((service) => service.ready(worker))).rejects.toMatchObject({
		code: 'incompatible',
	})
	expect(nativeWrites(f.calls)).toEqual([])
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

test('a pull request maps to its fork head, pinned by both the pull and branch refs', async () => {
	const head = {
		repository: 'owner/repo',
		sourceRepository: 'fork/repo',
		number: 1,
		headRef: 'feature',
		headSha: 'a'.repeat(40),
		baseSha: 'b'.repeat(40),
	}
	expect(await Effect.runPromise(pullRequestSource(head))).toEqual(source)
	await expect(
		Effect.runPromise(pullRequestSource({ ...head, headRef: 'bad..ref' })),
	).rejects.toBeDefined()
})

test('preparation sends the exact owned session request through the typed Capsule RPC', async () => {
	const f = fixture()
	await f.run((service) => service.prepareSession(worker, identity, { source, pr }))
	const [call] = f.calls
	expect(call?.url.pathname).toBe('/api/rpc/capsule/prepareSession')
	expect(call?.url.searchParams.get('location[directory]')).toBe(worker.controlDirectory)
	expect(call?.body).toEqual({
		input: {
			storageId: identity.storageId,
			workspaceId: identity.workspaceId,
			sessionId: identity.sessionId,
			owner: { namespace: 'pipeline', id: identity.taskId },
			source,
			agent: 'review',
			metadata: { pipeline: { taskId: identity.taskId, pr } },
		},
	})
	expect(f.calls).toHaveLength(1)
})

test('only preparation outlasts the ordinary deadline, so a slow environment build is not abandoned', async () => {
	const f = fixture()
	const prepare = f.hold('/api/rpc/capsule/prepareSession')
	await f.runTimed(
		(service) => service.prepareSession(worker, identity, { source, pr }),
		10 * 60_000,
		prepare,
	)
	const proof = f.hold('/api/rpc/capsule/getSession')
	await expect(
		f.runTimed((service) => service.requirePlacement(worker, identity), 15001, proof),
	).rejects.toMatchObject({ code: 'unavailable' })
})

test('a Capsule placement other than the pinned workspace, session and directory is refused', async () => {
	const f = fixture()
	for (const placed of [
		{ ...f.state.placed, directory: '/home/operator/ordinary-checkout' },
		{ ...f.state.placed, workspaceId: 'wrk_other' },
		{ ...f.state.placed, sessionId: 'ses_other' },
	]) {
		f.state.placed = placed
		await expect(
			f.run((service) => service.prepareSession(worker, identity, { source, pr })),
		).rejects.toMatchObject({ code: 'ownership' })
		await expect(
			f.run((service) => service.requirePlacement(worker, identity)),
		).rejects.toMatchObject({ code: 'ownership' })
		await expect(
			f.run((service) => service.findAdmission(worker, identity, messageId, 'exact prompt')),
		).rejects.toMatchObject({ code: 'ownership' })
		await expect(f.run((service) => service.observe(worker, identity))).rejects.toMatchObject({
			code: 'ownership',
		})
	}
	expect(f.calls.every((call) => rpcMethod(call) !== undefined)).toBe(true)
})

test('a stopped or purged Capsule still proves its retained identity for exact admission and observation', async () => {
	const f = fixture()
	f.state.messages.set(messageId, {
		id: messageId,
		type: 'user',
		text: 'exact prompt',
		time: { created: 0 },
	})
	for (const [capsulePhase, workspaceState] of [
		['stopped', 'bound'],
		['purged', 'absent'],
		['ready', 'absent'],
	] as const) {
		f.state.placed = { ...f.state.placed, capsulePhase, workspaceState }
		expect(await f.run((service) => service.requirePlacement(worker, identity))).toEqual(
			f.state.placed,
		)
		expect(
			await f.run((service) => service.findAdmission(worker, identity, messageId, 'exact prompt')),
		).toEqual({ sessionId: identity.sessionId, messageId })
		expect(await f.run((service) => service.observe(worker, identity, messageId))).toEqual({
			_tag: 'Idle',
		})
	}
	expect(f.calls.map(rpcMethod).filter((method) => method === 'prepareSession')).toEqual([])
	expect(nativeWrites(f.calls)).toEqual([])
})

test('declared Capsule rejections and cold registration translate without implying failure', async () => {
	const f = fixture()
	const rejected = (code: string) => ({ type: 'rejected', message: 'Rejected', data: { code } })
	for (const [failure, code] of [
		[rejected('ownership'), 'ownership'],
		[rejected('incompatible'), 'incompatible'],
		[rejected('invalid_input'), 'protocol'],
		[rejected('not_ready'), 'unavailable'],
		[rejected('unavailable'), 'unavailable'],
		[{ type: 'rpc.unavailable', message: 'RPC is unavailable: capsule' }, 'unavailable'],
		[{ type: 'rpc.method_not_found', message: 'Unknown RPC method' }, 'incompatible'],
	] as const) {
		f.state.rpcFailures.getSession = failure
		await expect(
			f.run((service) => service.requirePlacement(worker, identity)),
		).rejects.toMatchObject({ code })
	}
	f.state.rpcFailures.getSession = rejected('not_ready')
	await expect(f.run((service) => service.observe(worker, identity))).rejects.toMatchObject({
		code: 'unavailable',
	})
	expect(f.calls.every((call) => rpcMethod(call) === 'getSession')).toBe(true)
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
	expect(nativeWrites(f.calls)).toHaveLength(1)
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
	expect(nativeWrites(f.calls)).toEqual([])
})

test('missing input is not acknowledged and idle cannot finish a wait before target delivery', async () => {
	const f = fixture()
	expect(
		await f.run((service) => service.findAdmission(worker, identity, messageId, 'exact prompt')),
	).toBeUndefined()
	expect(await f.run((service) => service.observe(worker, identity, messageId))).toEqual({
		_tag: 'NotObserved',
	})
	expect(nativeWrites(f.calls)).toEqual([])
	expect(f.calls.filter(rpcMethod).map(rpcMethod)).toEqual(['getSession', 'getSession'])
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

test('a finished background job keeps the session running until its notice is admitted', async () => {
	const f = fixture()
	f.state.jobs = [
		{
			kind: 'shell',
			id: 'shl_checks',
			sessionID: identity.sessionId,
			status: 'completed',
			time: { started: 0, completed: 1 },
			shellID: 'shl_checks',
			command: 'make check',
		},
	]
	expect(await f.run((service) => service.observe(worker, identity))).toEqual({
		_tag: 'Running',
		backgroundJobs: 1,
	})
	f.state.jobs = []
	expect(await f.run((service) => service.observe(worker, identity))).toEqual({ _tag: 'Idle' })
})
