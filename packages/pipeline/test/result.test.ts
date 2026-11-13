import { Effect, FileSystem, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { expect, test } from 'vitest'
import type { SessionIdentity, Worker } from '../worker/schema'
import { OpenCodeWorker, openCodeWorkerLayer } from '../worker/service'

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
const target = 'msg_target'

type Fact = { type: string; data: Record<string, unknown> }
type Content =
	| { type: 'text'; text: string }
	| { type: 'reasoning'; text: string }
	| { type: 'tool'; name: string }

const enqueued = (
	id: string,
	{
		type = 'user',
		delivery = 'queue',
		metadata,
	}: { type?: 'user' | 'synthetic'; delivery?: string; metadata?: Record<string, unknown> } = {},
): Fact => ({
	type: 'session.inbox.enqueued',
	data: {
		inboxID: id,
		item: { type, payload: { text: `prompt ${id}`, ...(metadata ? { metadata } : {}) }, delivery },
	},
})
/** A native background completion notice: a steered synthetic carrying its source identity. */
const notice = (id: string, metadata: Record<string, unknown>): Fact[] => [
	enqueued(id, { type: 'synthetic', delivery: 'steer', metadata }),
	delivered(id),
]
const subagentDone = (childID: string) => ({
	source: 'subagent',
	childID,
	agent: 'helper',
	state: 'completed',
})
const shellDone = (shellID: string) => ({
	source: 'shell',
	shellID,
	jobID: shellID,
	state: 'completed',
})
/** One tool call of `step`, with the result metadata the native tool reports. */
const tool = (step: string, name: string, metadata: Record<string, unknown>): Fact[] => {
	const id = `call_${step}_${name}`
	return [
		{ type: 'session.tool.input.started', data: { assistantMessageID: step, id, name } },
		{
			type: 'session.tool.success',
			data: {
				assistantMessageID: step,
				id,
				content: [{ type: 'text', text: 'Tool output' }],
				metadata,
				executed: false,
			},
		},
	]
}
const backgroundSubagent = (step: string, child: string) =>
	tool(step, 'subagent', { sessionID: child, status: 'running' })
const backgroundShell = (step: string, shellID: string) =>
	tool(step, 'shell', { status: 'running', truncated: false, shellID })
const shellJob = (shellID: string, status: string) => ({
	kind: 'shell',
	id: shellID,
	sessionID: identity.sessionId,
	status,
	time: { started: 0 },
	shellID,
	command: 'make check',
})
const delivered = (id: string): Fact => ({ type: 'session.inbox.delivered', data: { inboxID: id } })
const cancelled = (id: string): Fact => ({ type: 'session.inbox.cancelled', data: { inboxID: id } })
const started: Fact = { type: 'session.execution.started', data: {} }
const succeeded: Fact = { type: 'session.execution.succeeded', data: {} }
const executionFailed: Fact = {
	type: 'session.execution.failed',
	data: { error: { type: 'provider', message: 'Provider refused', status: 500 } },
}
const interrupted = (reason: string): Fact => ({
	type: 'session.execution.interrupted',
	data: { reason },
})
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const stepStarted = (id: string): Fact => ({
	type: 'session.step.started',
	data: {
		assistantMessageID: id,
		agent: 'review',
		model: { id: 'model', providerID: 'provider' },
		started: 0,
	},
})
const stepEnded = (id: string, finish = 'stop'): Fact => ({
	type: 'session.step.ended',
	data: { assistantMessageID: id, finish, cost: 0, tokens },
})
const stepFailed = (id: string): Fact => ({
	type: 'session.step.failed',
	data: { assistantMessageID: id, error: { type: 'provider', message: 'Stream failed' } },
})
const textEnded = (id: string, text: string): Fact => ({
	type: 'session.text.ended',
	data: { assistantMessageID: id, ordinal: 0, text },
})
/** One complete model step, mirrored as the projected assistant message OpenCode serves. */
const step = (
	state: ReturnType<typeof fixture>['state'],
	id: string,
	content: Content[],
	finish = 'stop',
	tools: Fact[] = [],
): Fact[] => {
	state.messages.set(id, {
		id,
		type: 'assistant',
		agent: 'review',
		model: { id: 'model', providerID: 'provider' },
		finish,
		content: content.map((part) =>
			part.type === 'tool'
				? {
						type: 'tool',
						id: `call_${id}`,
						name: part.name,
						state: { status: 'streaming', input: '' },
						time: { created: 0 },
					}
				: part,
		),
		time: { created: 0, completed: 1 },
	})
	return [
		stepStarted(id),
		...tools,
		...content.flatMap((part) => (part.type === 'text' ? [textEnded(id, part.text)] : [])),
		stepEnded(id, finish),
	]
}

const unavailable = (reason: string) => ({
	_tag: 'Unavailable',
	message: expect.stringContaining(reason),
})

/** A step with locally executed tools, which native always continues, and the response step after it. */
const toolTurn = (
	state: ReturnType<typeof fixture>['state'],
	id: string,
	tools: Fact[],
	text: string,
): Fact[] => [
	stepStarted(id),
	...tools,
	stepEnded(id, 'tool-calls'),
	...step(state, `${id}r`, [{ type: 'text', text }]),
]

const frame = (value: unknown) => `event: message\ndata: ${JSON.stringify(value)}\n\n`

function fixture() {
	const requests: string[] = []
	const state = {
		log: [] as Fact[],
		children: new Map<string, Fact[]>(),
		messages: new Map<string, Record<string, unknown>>(),
		/** Ends the replay stream before OpenCode's sync marker, like a dropped connection. */
		truncated: false,
		inbox: [] as unknown[],
		active: {} as Record<string, { type: 'running' }>,
		jobs: [] as unknown[],
		/** Runs while the background job list is read, as a notice racing the live checks would. */
		duringJobs: undefined as (() => void) | undefined,
	}
	const fetch = async (input: string | URL | Request) => {
		const url = new URL(String(input))
		requests.push(url.pathname)
		if (url.pathname === '/api/rpc/capsule/getSession')
			return Response.json({
				output: {
					workspaceId: identity.workspaceId,
					sessionId: identity.sessionId,
					directory: identity.directory,
					capsulePhase: 'ready',
					workspaceState: 'bound',
				},
			})
		if (url.pathname === '/api/session/active') return Response.json({ data: state.active })
		if (url.pathname === `/api/session/${identity.sessionId}/inbox`)
			return Response.json({ data: state.inbox })
		if (url.pathname === '/api/experimental/job') {
			state.duringJobs?.()
			state.duringJobs = undefined
			return Response.json({ data: state.jobs })
		}
		const logged = url.pathname.match(/^\/api\/experimental\/session\/([^/]+)\/log$/)?.[1]
		if (logged !== undefined) {
			const log = logged === identity.sessionId ? state.log : (state.children.get(logged) ?? [])
			const after = Number(url.searchParams.get('after') ?? -1)
			const entries = log
				.map((entry, seq) => ({
					id: `evt_${seq}`,
					created: seq,
					type: entry.type,
					durable: {
						aggregateID: logged,
						seq,
						version: /^session\.tool\.(success|failed)$/.test(entry.type) ? 2 : 1,
					},
					data: { sessionID: logged, ...entry.data },
				}))
				.filter((entry) => entry.durable.seq > after)
			const synced = {
				type: 'log.synced',
				aggregateID: logged,
				...(log.length === 0 ? {} : { seq: log.length - 1 }),
			}
			const items = state.truncated ? entries : [...entries, synced]
			return new Response(items.map(frame).join(''), {
				headers: { 'content-type': 'text/event-stream' },
			})
		}
		const message = url.pathname.match(/^\/api\/session\/[^/]+\/message\/([^/]+)$/)?.[1]
		if (message !== undefined) {
			const found = state.messages.get(message)
			return found
				? Response.json({ data: found })
				: Response.json(
						{
							_tag: 'MessageNotFoundError',
							sessionID: identity.sessionId,
							messageID: message,
							message: 'Missing message',
						},
						{ status: 404 },
					)
		}
		throw new Error(`Unexpected request ${url.pathname}`)
	}
	const layer = openCodeWorkerLayer.pipe(
		Layer.provide(
			Layer.merge(
				FetchHttpClient.layer,
				Layer.succeed(
					FileSystem.FileSystem,
					FileSystem.makeNoop({ readFileString: () => Effect.succeed('password') }),
				),
			),
		),
	)
	const result = (messageId = target) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* OpenCodeWorker
				return yield* service.result(worker, identity, messageId)
			}).pipe(
				Effect.provide(layer),
				Effect.provideService(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch),
			),
		)
	return { state, requests, result }
}

test('an earlier response never answers a target still waiting in the inbox', async () => {
	const f = fixture()
	f.state.log = [
		enqueued('msg_earlier'),
		delivered('msg_earlier'),
		started,
		...step(f.state, 'msg_a1', [{ type: 'text', text: 'Earlier answer' }]),
		enqueued(target),
		succeeded,
	]
	expect(await f.result()).toEqual({ _tag: 'Pending' })
	f.state.log.push(delivered(target), started)
	expect(await f.result()).toEqual({ _tag: 'Pending' })
})

test('a settled target keeps its own response whatever later prompts do', async () => {
	const f = fixture()
	f.state.log = [
		enqueued(target),
		delivered(target),
		started,
		...step(f.state, 'msg_a1', [{ type: 'text', text: 'Target answer' }]),
		succeeded,
		enqueued('msg_later'),
		delivered('msg_later'),
		started,
		stepStarted('msg_a2'),
	]
	const completed = {
		_tag: 'Completed',
		message: { id: 'msg_a1', text: 'Target answer' },
	}
	expect(await f.result()).toEqual(completed)
	f.state.log.push(stepFailed('msg_a2'), executionFailed)
	expect(await f.result()).toEqual(completed)
	f.state.log.push(enqueued('msg_again'), delivered('msg_again'), started)
	expect(await f.result()).toEqual(completed)
})

test('queued prompts sharing one busy period are separated at the next queued delivery', async () => {
	const f = fixture()
	f.state.log = [
		enqueued(target),
		enqueued('msg_b'),
		delivered(target),
		started,
		...step(f.state, 'msg_a1', [{ type: 'text', text: 'Answer A' }]),
		delivered('msg_b'),
		...step(f.state, 'msg_b1', [{ type: 'text', text: 'Answer B' }]),
		succeeded,
	]
	expect(await f.result()).toEqual({
		_tag: 'Completed',
		message: { id: 'msg_a1', text: 'Answer A' },
	})
	expect(await f.result('msg_b')).toEqual({
		_tag: 'Completed',
		message: { id: 'msg_b1', text: 'Answer B' },
	})
})

test('only the final step answers, joining its text parts without reasoning or tool preambles', async () => {
	const f = fixture()
	f.state.log = [
		enqueued(target),
		delivered(target),
		started,
		...step(
			f.state,
			'msg_a1',
			[
				{ type: 'text', text: 'Let me inspect the diff first.' },
				{ type: 'tool', name: 'read' },
			],
			'tool-calls',
		),
		{
			type: 'session.synthetic',
			data: { text: 'The previous response was interrupted. Continue.' },
		},
		...step(f.state, 'msg_a2', [
			{ type: 'reasoning', text: 'private reasoning' },
			{ type: 'text', text: 'First line\nsecond line' },
			{ type: 'text', text: '' },
			{ type: 'text', text: 'Verdict: approve' },
		]),
		succeeded,
	]
	expect(await f.result()).toEqual({
		_tag: 'Completed',
		message: { id: 'msg_a2', text: 'First line\nsecond line\n\n\n\nVerdict: approve' },
	})
})

test('a successful turn whose final step has no text completes without a message', async () => {
	const f = fixture()
	f.state.log = [
		enqueued(target),
		delivered(target),
		started,
		...step(f.state, 'msg_a1', [
			{ type: 'reasoning', text: 'thinking only' },
			{ type: 'text', text: '' },
		]),
		succeeded,
	]
	expect(await f.result()).toEqual({ _tag: 'CompletedWithoutMessage' })
})

test('a failed busy period reports its error even after partial text', async () => {
	const f = fixture()
	f.state.log = [
		enqueued(target),
		delivered(target),
		started,
		stepStarted('msg_a1'),
		textEnded('msg_a1', 'Partial review'),
		stepFailed('msg_a1'),
		executionFailed,
	]
	expect(await f.result()).toEqual({
		_tag: 'Failed',
		error: { type: 'provider', message: 'Provider refused' },
	})
})

test('cancellation and user interruption settle the target without a response', async () => {
	const f = fixture()
	f.state.log = [enqueued(target), cancelled(target)]
	expect(await f.result()).toEqual({ _tag: 'InputCancelled' })
	f.state.log = [
		enqueued(target),
		delivered(target),
		started,
		stepStarted('msg_a1'),
		textEnded('msg_a1', 'Partial'),
		stepFailed('msg_a1'),
		interrupted('user'),
	]
	expect(await f.result()).toEqual({ _tag: 'Interrupted', reason: 'user' })
})

test('a shutdown stays pending through native recovery until the resumed turn settles', async () => {
	const f = fixture()
	const suspended = [
		enqueued(target),
		delivered(target),
		started,
		stepStarted('msg_a1'),
		stepFailed('msg_a1'),
		interrupted('shutdown'),
	]
	f.state.log = [...suspended]
	expect(await f.result()).toEqual({ _tag: 'Pending' })
	f.state.log.push(
		{ type: 'session.synthetic', data: { text: 'The server restarted while you were working.' } },
		started,
	)
	expect(await f.result()).toEqual({ _tag: 'Pending' })
	f.state.log.push(
		...step(f.state, 'msg_a2', [{ type: 'text', text: 'Resumed answer' }]),
		succeeded,
	)
	expect(await f.result()).toEqual({
		_tag: 'Completed',
		message: { id: 'msg_a2', text: 'Resumed answer' },
	})
	f.state.log = [
		...suspended,
		{
			type: 'session.execution.failed',
			data: { error: { type: 'aborted', message: 'Execution was interrupted repeatedly' } },
		},
	]
	expect(await f.result()).toEqual({
		_tag: 'Failed',
		error: { type: 'aborted', message: 'Execution was interrupted repeatedly' },
	})
})

test('steered user input makes the response unattributable, but steered notices continue the turn', async () => {
	const f = fixture()
	f.state.log = [
		enqueued(target),
		delivered(target),
		started,
		stepStarted('msg_a1'),
		enqueued('msg_notice', { type: 'synthetic', delivery: 'steer' }),
		delivered('msg_notice'),
		stepEnded('msg_a1', 'tool-calls'),
		...step(f.state, 'msg_a2', [{ type: 'text', text: 'Answer after notice' }]),
		succeeded,
	]
	expect(await f.result()).toEqual({
		_tag: 'Completed',
		message: { id: 'msg_a2', text: 'Answer after notice' },
	})
	f.state.log = [
		enqueued(target),
		delivered(target),
		started,
		stepStarted('msg_a1'),
		enqueued('msg_steer', { delivery: 'steer' }),
		delivered('msg_steer'),
		stepEnded('msg_a1', 'tool-calls'),
		...step(f.state, 'msg_a2', [{ type: 'text', text: 'Mixed answer' }]),
		succeeded,
	]
	expect(await f.result()).toEqual(unavailable('steered'))
	f.state.log = [
		enqueued(target),
		{ type: 'session.inbox.delivery.changed', data: { inboxID: target, delivery: 'steer' } },
		enqueued('msg_other'),
		delivered('msg_other'),
		started,
		delivered(target),
		...step(f.state, 'msg_a1', [{ type: 'text', text: 'Mixed answer' }]),
		succeeded,
	]
	expect(await f.result()).toEqual(unavailable('steered'))
})

test('missing history, an unsettled final step, or a removed message is unavailable', async () => {
	const f = fixture()
	f.state.log = [enqueued('msg_other')]
	expect(await f.result()).toEqual(unavailable('no record'))
	f.state.log = [
		enqueued(target),
		delivered(target),
		started,
		stepStarted('msg_a1'),
		stepFailed('msg_a1'),
		succeeded,
	]
	expect(await f.result()).toEqual(unavailable('did not settle'))
	f.state.log = [
		enqueued(target),
		delivered(target),
		started,
		...step(f.state, 'msg_a1', [{ type: 'text', text: 'Reverted' }]),
		succeeded,
	]
	f.state.messages.clear()
	expect(await f.result()).toEqual(unavailable('no longer exists'))
})

test('a replay that ends before its sync marker is a transport failure, never absence', async () => {
	const f = fixture()
	f.state.log = [enqueued(target)]
	f.state.truncated = true
	await expect(f.result()).rejects.toMatchObject({ _tag: 'WorkerError', code: 'unavailable' })
	f.state.truncated = false
	expect(await f.result()).toEqual({ _tag: 'Pending' })
})

test('the replay stops at a proven boundary and reads the whole history otherwise', async () => {
	const f = fixture()
	const filler = Array.from(
		{ length: 100_001 },
		(): Fact => ({ type: 'session.renamed', data: { title: 'Busy' } }),
	)
	f.state.log = [
		...filler,
		enqueued(target),
		delivered(target),
		started,
		...step(f.state, 'msg_a1', [{ type: 'text', text: 'Late answer' }]),
		succeeded,
	]
	expect(await f.result()).toEqual({
		_tag: 'Completed',
		message: { id: 'msg_a1', text: 'Late answer' },
	})
	f.state.log = [enqueued(target), cancelled(target), ...filler]
	f.state.truncated = true
	expect(await f.result()).toEqual({ _tag: 'InputCancelled' })
}, 60_000)

test('a turn waiting on a background helper settles only after its notice and a later response', async () => {
	const f = fixture()
	f.state.children.set('ses_helper', [stepStarted('msg_c1'), stepEnded('msg_c1')])
	f.state.log = [
		enqueued(target),
		delivered(target),
		started,
		...toolTurn(
			f.state,
			'msg_a1',
			backgroundSubagent('msg_a1', 'ses_helper'),
			'Waiting for the helper.',
		),
		succeeded,
	]
	expect(await f.result()).toEqual({ _tag: 'Pending' })
	f.state.log.push(
		...notice('msg_notice', subagentDone('ses_helper')),
		started,
		...step(f.state, 'msg_a2', [{ type: 'text', text: 'Final review' }]),
		succeeded,
	)
	expect(await f.result()).toEqual({
		_tag: 'Completed',
		message: { id: 'msg_a2', text: 'Final review' },
	})
	expect(f.requests).toContain('/api/experimental/session/ses_helper/log')
})

test('a finished job whose notice is not yet admitted keeps the turn pending', async () => {
	const f = fixture()
	f.state.log = [
		enqueued(target),
		delivered(target),
		started,
		...toolTurn(f.state, 'msg_a1', backgroundShell('msg_a1', 'shl_checks'), 'Started the checks.'),
		succeeded,
	]
	f.state.jobs = [shellJob('shl_checks', 'completed')]
	expect(await f.result()).toEqual({ _tag: 'Pending' })
	f.state.jobs = []
	f.state.log.push(...notice('msg_notice', shellDone('shl_checks')), started, stepStarted('msg_a2'))
	expect(await f.result()).toEqual({ _tag: 'Pending' })
	f.state.log.push(textEnded('msg_a2', 'Checks passed'), stepEnded('msg_a2'), succeeded)
	f.state.messages.set('msg_a2', {
		id: 'msg_a2',
		type: 'assistant',
		agent: 'review',
		model: { id: 'model', providerID: 'provider' },
		content: [{ type: 'text', text: 'Checks passed' }],
		time: { created: 0, completed: 1 },
	})
	expect(await f.result()).toEqual({
		_tag: 'Completed',
		message: { id: 'msg_a2', text: 'Checks passed' },
	})
})

test('a candidate response is confirmed only against live state that the log did not outrun', async () => {
	const f = fixture()
	f.state.log = [
		enqueued('msg_earlier'),
		delivered('msg_earlier'),
		started,
		...toolTurn(f.state, 'msg_e1', backgroundShell('msg_e1', 'shl_old'), 'Started old checks.'),
		succeeded,
		enqueued(target),
		delivered(target),
		started,
		...step(f.state, 'msg_a1', [{ type: 'text', text: 'Target answer' }]),
		succeeded,
	]
	const completed = { _tag: 'Completed', message: { id: 'msg_a1', text: 'Target answer' } }
	f.state.jobs = [shellJob('shl_old', 'completed')]
	expect(await f.result()).toEqual({ _tag: 'Pending' })
	f.state.duringJobs = () => {
		f.state.log.push(...notice('msg_old_notice', shellDone('shl_old')), started)
		f.state.jobs = []
	}
	expect(await f.result()).toEqual(completed)
	f.state.log.splice(-3)
	f.state.jobs = [{ ...shellJob('img_unknown', 'completed'), kind: 'image', path: 'a', model: 'b' }]
	f.state.duringJobs = () => {
		f.state.log.push(
			...notice('msg_image', { source: 'experimental_image_generate', jobID: 'img_unknown' }),
		)
		f.state.jobs = []
	}
	expect(await f.result()).toEqual(unavailable('unattributed background notice'))
	f.state.log.splice(-2)
	f.state.active = { [identity.sessionId]: { type: 'running' } }
	expect(await f.result()).toEqual({ _tag: 'Pending' })
	f.state.active = {}
	f.state.inbox = [
		{
			id: 'msg_queued',
			sessionID: identity.sessionId,
			type: 'user',
			payload: { text: 'later' },
			delivery: 'queue',
			time: { created: 0 },
		},
	]
	expect(await f.result()).toEqual({ _tag: 'Pending' })
})

test('independent input while background work is outstanding does not complete the earlier turn', async () => {
	const f = fixture()
	f.state.log = [
		enqueued(target),
		delivered(target),
		started,
		...toolTurn(f.state, 'msg_a1', backgroundShell('msg_a1', 'shl_checks'), 'Waiting for checks.'),
		succeeded,
		enqueued('msg_b'),
		delivered('msg_b'),
		started,
		...step(f.state, 'msg_b1', [{ type: 'text', text: 'Answer B' }]),
		succeeded,
	]
	expect(await f.result()).toEqual(unavailable('Independent input'))
	f.state.log.push(...notice('msg_notice', shellDone('shl_checks')), started)
	expect(await f.result()).toEqual(unavailable('Independent input'))
	expect(await f.result('msg_b')).toEqual({
		_tag: 'Completed',
		message: { id: 'msg_b1', text: 'Answer B' },
	})
	f.state.log = [
		...f.state.log.slice(0, f.state.log.indexOf(succeeded) + 1),
		enqueued('msg_b'),
		delivered('msg_b'),
		started,
		stepStarted('msg_b1'),
		...notice('msg_notice', shellDone('shl_checks')),
		stepEnded('msg_b1'),
		succeeded,
	]
	expect(await f.result('msg_b')).toEqual(unavailable('background notices entered'))
})

test('a subagent with detached or nested work cannot prove its reported completion settled', async () => {
	const f = fixture()
	f.state.log = [
		enqueued(target),
		delivered(target),
		started,
		...toolTurn(
			f.state,
			'msg_a1',
			tool('msg_a1', 'subagent', { sessionID: 'ses_helper', status: 'completed' }),
			'Helper says done',
		),
		succeeded,
	]
	f.state.children.set('ses_helper', [
		stepStarted('msg_c1'),
		...backgroundShell('msg_c1', 'shl_child'),
		stepEnded('msg_c1'),
	])
	expect(await f.result()).toEqual(unavailable('subagent'))
	f.state.children.set('ses_helper', [
		stepStarted('msg_c1'),
		...tool('msg_c1', 'subagent', { sessionID: 'ses_nested', status: 'completed' }),
		stepEnded('msg_c1'),
	])
	expect(await f.result()).toEqual(unavailable('subagent'))
	f.state.children.set('ses_helper', [stepStarted('msg_c1'), stepEnded('msg_c1')])
	expect(await f.result()).toEqual({
		_tag: 'Completed',
		message: { id: 'msg_a1r', text: 'Helper says done' },
	})
})

test('background launches without a native completion identity are unavailable', async () => {
	const f = fixture()
	f.state.log = [
		enqueued(target),
		delivered(target),
		started,
		...toolTurn(
			f.state,
			'msg_a1',
			tool('msg_a1', 'experimental_image_generate', { path: 'a', jobID: 'img_1' }),
			'Image requested',
		),
		succeeded,
	]
	expect(await f.result()).toEqual(unavailable('cannot be attributed'))
})

test('a tool or output-limit preamble never answers, even when recovery promotes other input first', async () => {
	const f = fixture()
	const preamble = (finish: string, tools: Fact[]) => [
		enqueued(target),
		enqueued('msg_b'),
		delivered(target),
		started,
		stepStarted('msg_a1'),
		...tools,
		textEnded('msg_a1', 'Let me inspect the diff first.'),
		stepEnded('msg_a1', finish),
	]
	f.state.messages.set('msg_a1', {
		id: 'msg_a1',
		type: 'assistant',
		agent: 'review',
		model: { id: 'model', providerID: 'provider' },
		finish: 'tool-calls',
		content: [{ type: 'text', text: 'Let me inspect the diff first.' }],
		time: { created: 0, completed: 1 },
	})
	const answerB = step(f.state, 'msg_b1', [{ type: 'text', text: 'Answer B' }])
	f.state.log = [
		...preamble('tool-calls', tool('msg_a1', 'read', { path: 'diff' })),
		interrupted('shutdown'),
		{ type: 'session.synthetic', data: { text: 'The server restarted while you were working.' } },
		started,
		delivered('msg_b'),
		...answerB,
		succeeded,
	]
	expect(await f.result()).toEqual(unavailable('shutdown interrupted this turn'))
	f.state.log = [
		...preamble('stop', []),
		interrupted('shutdown'),
		started,
		delivered('msg_b'),
		...answerB,
		succeeded,
	]
	expect(await f.result()).toEqual(unavailable('shutdown interrupted this turn'))
	f.state.log = [...preamble('length', []), delivered('msg_b'), ...answerB, succeeded]
	expect(await f.result()).toEqual(unavailable('did not settle a response'))
	f.state.log = [...preamble('tool-calls', tool('msg_a1', 'read', { path: 'diff' })), succeeded]
	expect(await f.result()).toEqual(unavailable('did not settle a response'))
	f.state.log = [enqueued(target), delivered(target), started, succeeded]
	expect(await f.result()).toEqual(unavailable('No native response settled'))
})

test('calling an outstanding helper again cannot be matched to its one completion notice', async () => {
	const f = fixture()
	f.state.children.set('ses_helper', [stepStarted('msg_c1'), stepEnded('msg_c1')])
	f.state.log = [
		enqueued(target),
		delivered(target),
		started,
		...toolTurn(f.state, 'msg_a1', backgroundSubagent('msg_a1', 'ses_helper'), 'Started.'),
		...toolTurn(f.state, 'msg_a2', backgroundSubagent('msg_a2', 'ses_helper'), 'Asked again.'),
		succeeded,
		...notice('msg_notice', subagentDone('ses_helper')),
		started,
		...step(f.state, 'msg_a3', [{ type: 'text', text: 'Final review' }]),
		succeeded,
	]
	expect(await f.result()).toEqual(unavailable('relaunched a background helper'))
})

test('a failed subagent call still has its child checked for detached work', async () => {
	const f = fixture()
	const failedCall: Fact[] = [
		{
			type: 'session.tool.input.started',
			data: { assistantMessageID: 'msg_a1', id: 'call_helper', name: 'subagent' },
		},
		{
			type: 'session.tool.failed',
			data: {
				assistantMessageID: 'msg_a1',
				id: 'call_helper',
				error: { type: 'tool', message: 'Subagent failed (sessionID: ses_helper)' },
				metadata: { sessionID: 'ses_helper', status: 'running' },
				executed: false,
			},
		},
	]
	f.state.log = [
		enqueued(target),
		delivered(target),
		started,
		...toolTurn(f.state, 'msg_a1', failedCall, 'The helper failed.'),
		succeeded,
	]
	f.state.children.set('ses_helper', [
		stepStarted('msg_c1'),
		...backgroundShell('msg_c1', 'shl_child'),
		stepFailed('msg_c1'),
	])
	expect(await f.result()).toEqual(unavailable('subagent'))
	expect(f.requests).toContain('/api/experimental/session/ses_helper/log')
	f.state.children.set('ses_helper', [stepStarted('msg_c1'), stepFailed('msg_c1')])
	expect(await f.result()).toEqual({
		_tag: 'Completed',
		message: { id: 'msg_a1r', text: 'The helper failed.' },
	})
})
