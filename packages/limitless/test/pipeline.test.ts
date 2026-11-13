import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { Agent } from '@opencode/schema/agent'
import { Tool } from '@opencode/schema/tool'
import { Deferred, Effect, Fiber, Redacted, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { TestClock } from 'effect/testing'
import { afterEach, describe, expect, test } from 'vitest'
import {
	canonicalPullRequest,
	nativeEvaluationBudgetMs,
	type OperationState,
	type OperationView,
} from '../../pipeline/workflow'
import { makePipelineClient } from '../tools/pipeline/client'
import { normalizePipelinePluginConfig, readPipelineToken } from '../tools/pipeline/config'
import { hidePipelineMutations } from '../tools/pipeline/index'
import { pipelineMutationTools, pipelineTools } from '../tools/pipeline/tools'
import { testToolContext, testToolExecution } from './execution'

const pr = 'https://github.com/owner/repo/pull/123'
const token = 'fixture-token-not-a-real-secret-123456789'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close()
})

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function signal() {
	const callbacks = { resolve: () => {} }
	const promise = new Promise<void>((resolve) => {
		callbacks.resolve = resolve
	})
	return { promise, resolve: () => callbacks.resolve() }
}

type Recorded = { method: string; path: string; body: string; key: string | undefined }

async function fixture() {
	const requests: Array<Recorded> = []
	const operations = new Map<string, OperationView>()
	const reviews = new Map<string, string>()
	const successors = new Map<string, string>()
	const events = new Map<ServerResponse, string>()
	const state = {
		loseNext: false,
		conflict: undefined as string | undefined,
		redirect: undefined as string | undefined,
		readStatus: 200,
		hold: undefined as Promise<void> | undefined,
		initialView: true,
		eventCount: 0,
		onEvents: (_response: ServerResponse, _count: number, _operation: string) => {},
		handleRequest: (_method: string, _path: string, _response: ServerResponse) => false,
	}
	const create = (pullRequest: string, next: OperationState = { _tag: 'Queued' }) => {
		const view: OperationView = {
			operation: randomUUID(),
			pr: pullRequest,
			closed: false,
			state: next,
		}
		operations.set(view.operation, view)
		return view
	}
	const receipt = ({ operation, pr, closed }: OperationView) => ({ operation, pr, closed })
	const frame = (operation: string) => `${JSON.stringify(operations.get(operation))}\n`
	const eventOpened = signal()

	const server = createServer(async (request, response) => {
		const chunks: Array<Buffer> = []
		for await (const chunk of request) chunks.push(Buffer.from(chunk))
		const body = Buffer.concat(chunks).toString()
		const path = request.url ?? '/'
		const method = request.method ?? 'GET'
		const key = request.headers['idempotency-key']
		requests.push({ method, path, body, key: typeof key === 'string' ? key : undefined })
		if (state.redirect !== undefined) {
			response.writeHead(302, { location: state.redirect }).end()
			return
		}
		if (request.headers.authorization !== `Bearer ${token}`) {
			response.writeHead(401).end()
			return
		}
		if (state.handleRequest(method, path, response)) return
		if (method === 'POST') await state.hold
		if (method === 'GET' && state.readStatus !== 200) {
			response.writeHead(state.readStatus).end()
			return
		}
		const json = (value: unknown, status = 200) =>
			response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
		const admitted = (value: unknown, status = 202) => {
			if (!state.loseNext) return json(value, status)
			state.loseNext = false
			response.destroy()
		}

		if (method === 'POST' && path === '/reviews') {
			const requested = canonicalPullRequest(JSON.parse(body).pr)
			const current = operations.get(reviews.get(requested) ?? '') ?? create(requested)
			reviews.set(requested, current.operation)
			admitted(receipt(current))
			return
		}
		const [, , operation = '', action] = path.split('/')
		const target = operations.get(operation)
		if (target === undefined) {
			json({ _tag: 'OperationNotFound', operation }, 404)
			return
		}
		if (method === 'POST' && state.conflict !== undefined) {
			json({ _tag: 'TaskConflict', code: state.conflict }, 409)
			return
		}
		if (method === 'POST' && (action === 'continue' || action === 'restart')) {
			const anchored = `${action}:${operation}`
			const recorded = operations.get(successors.get(anchored) ?? '')
			if (recorded !== undefined) {
				admitted(receipt(recorded))
				return
			}
			const next = create(target.pr)
			successors.set(anchored, next.operation)
			reviews.set(target.pr, next.operation)
			admitted(receipt(next))
			return
		}
		if (method === 'POST' && action === 'interrupt') {
			admitted({ ...receipt(target), status: 'Requested' })
			return
		}
		if (action === 'events') {
			state.eventCount++
			response.writeHead(200, { 'content-type': 'application/x-ndjson' })
			response.write('\n')
			if (state.initialView) response.write(frame(operation))
			events.set(response, operation)
			response.on('close', () => events.delete(response))
			state.onEvents(response, state.eventCount, operation)
			eventOpened.resolve()
			return
		}
		json(target)
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	cleanup.push(
		() =>
			new Promise<void>((resolve, reject) => {
				for (const event of events.keys()) event.destroy()
				server.close((error) => (error === undefined ? resolve() : reject(error)))
				server.closeAllConnections()
			}),
	)
	const update = (operation: string, next: OperationState) => {
		const view = operations.get(operation)
		if (view !== undefined) operations.set(operation, { ...view, state: next })
	}
	return {
		state,
		requests,
		operations,
		successors,
		events,
		create,
		frame,
		update,
		eventOpened: eventOpened.promise,
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		publish: (operation: string, next: OperationState) => {
			update(operation, next)
			for (const [response, subscribed] of events) response.write(`\n${frame(subscribed)}`)
		},
	}
}

async function caller(url: string) {
	const client = await Effect.runPromise(
		makePipelineClient({ url, token: Redacted.make(token) }).pipe(
			Effect.provide(FetchHttpClient.layer),
		),
	)
	return { client, tools: pipelineTools(client) }
}

function context(
	callId: string,
	agent = 'limitless',
	progress: Tool.Context['progress'] = () => Effect.void,
): Tool.Context {
	return {
		...testToolContext(testToolExecution('/fixture', 'ses_pipeline')),
		agent: Agent.ID.make(agent),
		id: Schema.decodeUnknownSync(Tool.CallID)(callId),
		progress,
	}
}

const failure = <A>(effect: Effect.Effect<A, Tool.Error>) => Effect.runPromise(Effect.flip(effect))
const evaluationResponseDeadlineMs = nativeEvaluationBudgetMs + 15_000
const routes = (requests: ReadonlyArray<Recorded>) =>
	requests.map(({ method, path }) => [method, path.replace(/[0-9a-f-]{36}/, ':op')])
const completed = (text: string): OperationState => ({
	_tag: 'Completed',
	message: { id: `msg_${randomUUID()}`, text },
})

describe('Pipeline caller mutations', () => {
	test('each mutation sends exactly its documented request, without idempotency keys or caller receipts', async () => {
		const remote = await fixture()
		const { tools } = await caller(remote.url)
		const review = await Effect.runPromise(
			tools.pipeline_review.execute(
				{ pr: 'https://github.com/Owner/Repo/pull/123/' },
				context('call_review'),
			),
		)
		expect(review.output).toEqual({ operation: expect.any(String), pr, closed: false })
		expect(review.content).toEqual([{ type: 'text', text: JSON.stringify(review.output) }])
		const first = review.output?.operation ?? ''
		const continued = await Effect.runPromise(
			tools.pipeline_continue.execute({ after: first }, context('call_continue')),
		)
		const second = continued.output?.operation ?? ''
		const restarted = await Effect.runPromise(
			tools.pipeline_restart.execute({ after: second }, context('call_restart')),
		)
		const third = restarted.output?.operation ?? ''
		const interrupted = await Effect.runPromise(
			tools.pipeline_interrupt.execute({ after: third }, context('call_interrupt')),
		)

		expect(new Set([first, second, third]).size).toBe(3)
		expect(interrupted.output).toEqual({ operation: third, pr, closed: false, status: 'Requested' })
		expect(remote.requests).toEqual([
			{ method: 'POST', path: '/reviews', body: JSON.stringify({ pr }), key: undefined },
			{ method: 'POST', path: `/operations/${first}/continue`, body: '', key: undefined },
			{ method: 'POST', path: `/operations/${second}/restart`, body: '', key: undefined },
			{ method: 'POST', path: `/operations/${third}/interrupt`, body: '', key: undefined },
		])
	})

	test('independent callers with no local state share the current review, and anchored retries keep their successor after later work', async () => {
		const remote = await fixture()
		const one = await caller(remote.url)
		const two = await caller(remote.url)
		const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)
		const initial = await run(one.client.review({ pr }))
		expect(await run(two.client.review({ pr: `${pr}/` }))).toEqual(initial)

		const successor = await run(one.client.continue({ after: initial.operation }))
		const later = await run(one.client.continue({ after: successor.operation }))
		expect(await run(two.client.continue({ after: initial.operation }))).toEqual(successor)
		expect(await run(two.client.review({ pr }))).toEqual(later)
		expect(remote.successors.size).toBe(2)
		expect(remote.requests).toHaveLength(6)
	})

	test.each([
		'review',
		'continue',
		'restart',
	] as const)('a lost %s response is admission_unknown with an exact-repeat instruction, and the repeat recovers the committed operation', async (operation) => {
		const remote = await fixture()
		const { tools } = await caller(remote.url)
		const anchor = remote.create(pr).operation
		const call = () => {
			if (operation === 'review') return tools.pipeline_review.execute({ pr }, context('call_a'))
			if (operation === 'continue')
				return tools.pipeline_continue.execute({ after: anchor }, context('call_a'))
			return tools.pipeline_restart.execute({ after: anchor }, context('call_a'))
		}
		remote.state.loseNext = true
		const lost = await failure(call())
		expect(lost.metadata).toMatchObject({ code: 'admission_unknown' })
		expect(lost.message).toContain('Repeat this exact tool call with identical arguments')
		expect(lost.message).toContain('may have started')
		expect(lost.message).toContain('recover the accepted or current work')

		const operationsAfterLoss = remote.operations.size
		const recovered = await Effect.runPromise(call())
		expect(remote.operations.size).toBe(operationsAfterLoss)
		expect(remote.requests).toHaveLength(2)
		expect(remote.requests[1]).toEqual(remote.requests[0])
		if (operation !== 'review')
			expect(recovered.output?.operation).toBe(remote.successors.get(`${operation}:${anchor}`))
	})

	test.each([
		'continue',
		'restart',
	] as const)('a %s whose readiness takes longer than ten seconds is accepted once, and an identical retry is unchanged', async (action) => {
		const remote = await fixture()
		const { client } = await caller(remote.url)
		const after = remote.create(pr, completed('Done.')).operation
		const received = signal()
		const ready = signal()
		remote.state.hold = ready.promise
		remote.state.handleRequest = () => {
			received.resolve()
			return false
		}
		const accepted = await Effect.runPromise(
			Effect.gen(function* () {
				const admitting = yield* client[action]({ after }).pipe(Effect.forkScoped)
				yield* Effect.promise(() => received.promise)
				yield* TestClock.adjust('11 seconds')
				expect(admitting.pollUnsafe()).toBeUndefined()
				ready.resolve()
				return yield* Fiber.join(admitting)
			}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
		)
		expect(accepted.operation).toBe(remote.successors.get(`${action}:${after}`))
		expect(await Effect.runPromise(client[action]({ after }))).toEqual(accepted)
		expect(remote.successors.size).toBe(1)
		expect(remote.requests).toHaveLength(2)
		expect(remote.requests[1]).toEqual(remote.requests[0])
	})

	test('a mutation response beyond the evaluation deadline is admission_unknown', async () => {
		const remote = await fixture()
		const { client } = await caller(remote.url)
		const after = remote.create(pr, completed('Done.')).operation
		const received = signal()
		remote.state.hold = new Promise(() => {})
		remote.state.handleRequest = () => {
			received.resolve()
			return false
		}
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const admitting = yield* Effect.flip(client.continue({ after })).pipe(Effect.forkScoped)
				yield* Effect.promise(() => received.promise)
				yield* TestClock.adjust(evaluationResponseDeadlineMs - 1)
				expect(admitting.pollUnsafe()).toBeUndefined()
				yield* TestClock.adjust(1)
				return yield* Fiber.join(admitting)
			}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
		)
		expect(error.code).toBe('admission_unknown')
		expect(remote.requests).toHaveLength(1)
	})

	test('a review receipt naming the canonical URL of a renamed repository is accepted', async () => {
		const remote = await fixture()
		const { tools } = await caller(remote.url)
		const canonical = remote.create('https://github.com/new-owner/renamed/pull/123')
		remote.state.handleRequest = (_method, _path, response) => {
			const { operation, pr, closed } = canonical
			response
				.writeHead(202, { 'content-type': 'application/json' })
				.end(JSON.stringify({ operation, pr, closed }))
			return true
		}
		const result = await Effect.runPromise(
			tools.pipeline_review.execute({ pr }, context('call_renamed')),
		)
		expect(result.output).toEqual({
			operation: canonical.operation,
			pr: canonical.pr,
			closed: false,
		})
		expect(remote.requests[0]?.body).toBe(JSON.stringify({ pr }))
	})

	test.each([
		'continue',
		'restart',
		'interrupt',
	] as const)('a %s receipt naming the wrong operation is not reported as admitted', async (route) => {
		const remote = await fixture()
		const { client } = await caller(remote.url)
		const anchor = remote.create(pr).operation
		remote.state.handleRequest = (_method, _path, response) => {
			const value = {
				operation: route === 'interrupt' ? randomUUID() : anchor,
				pr,
				closed: false,
				...(route === 'interrupt' ? { status: 'Requested' } : {}),
			}
			response.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify(value))
			return true
		}
		const operation = (() => {
			if (route === 'continue') return client.continue({ after: anchor })
			if (route === 'restart') return client.restart({ after: anchor })
			return client.interrupt({ after: anchor })
		})()
		expect((await Effect.runPromise(Effect.flip(operation))).code).toBe('admission_unknown')
	})

	test('credentialed requests never follow redirects or expose the token in errors', async () => {
		const destination = await fixture()
		const remote = await fixture()
		remote.state.redirect = destination.url
		const { tools } = await caller(remote.url)
		const error = await failure(tools.pipeline_review.execute({ pr }, context('call_redirect')))
		expect(error.metadata).toMatchObject({ code: 'admission_unknown' })
		expect(destination.requests).toHaveLength(0)
		expect(JSON.stringify(error)).not.toContain(token)
	})

	test.each([
		['operation_pending', 'Call pipeline_wait on it, then repeat this exact call'],
		['native_unsettled', 'Native settlement or idleness has not been established'],
		['observation_timeout', 'within its evaluation budget'],
		['delivery_unconfirmed', 'never resubmit it'],
		['stale_operation', 'Act on the current operation instead'],
		['task_closed', 'accepts no further messages'],
		['session_unavailable', 'native session is unavailable'],
		['future_code', 'Pipeline state conflicts with this request'],
	])('a %s conflict explains how to proceed and that this attempt submitted nothing', async (code, guidance) => {
		const remote = await fixture()
		const { tools } = await caller(remote.url)
		remote.state.conflict = code
		const after = remote.create(pr).operation
		const error = await failure(
			tools.pipeline_continue.execute({ after }, context('call_conflict')),
		)
		expect(error.metadata).toEqual({ code: 'conflict', conflict: code })
		expect(error.message).toContain(guidance)
		expect(error.message).toContain('this attempt submitted nothing new')
		expect(error.message).toContain('does not prove an earlier attempt was not accepted')
		expect(remote.operations.size).toBe(1)
	})

	test('an unknown operation is not_found and a refused credential is refused, not admission_unknown', async () => {
		const remote = await fixture()
		const { tools } = await caller(remote.url)
		const missing = await failure(
			tools.pipeline_continue.execute({ after: randomUUID() }, context('call_missing')),
		)
		expect(missing.metadata).toMatchObject({ code: 'not_found' })
		const waitMissing = await failure(
			tools.pipeline_wait.execute({ operation: randomUUID() }, context('call_wait_missing')),
		)
		expect(waitMissing.metadata).toMatchObject({ code: 'not_found' })

		const client = await Effect.runPromise(
			makePipelineClient({ url: remote.url, token: Redacted.make('wrong') }).pipe(
				Effect.provide(FetchHttpClient.layer),
			),
		)
		const refused = await Effect.runPromise(Effect.flip(client.review({ pr })))
		expect(refused.code).toBe('refused')
		expect(refused.message).toContain('does not prove an earlier attempt was not accepted')
	})

	test('malformed operation references and PR URLs are rejected at the tool schema boundary', async () => {
		const remote = await fixture()
		const { tools } = await caller(remote.url)
		const operation = randomUUID()
		const cases: Array<[Tool.Info, unknown, boolean]> = [
			[tools.pipeline_review, { pr }, true],
			[tools.pipeline_review, { pr: `${pr}/files` }, false],
			[tools.pipeline_review, { pr: 'https://gitlab.com/owner/repo/pull/1' }, false],
			[tools.pipeline_review, { pr: 'https://github.com/owner/repo/pull/0' }, false],
			[tools.pipeline_continue, { after: operation }, true],
			[tools.pipeline_continue, { after: operation.toUpperCase() }, false],
			[tools.pipeline_continue, { after: `../${operation}` }, false],
			[tools.pipeline_restart, { after: 'latest' }, false],
			[tools.pipeline_interrupt, {}, false],
			[tools.pipeline_wait, { operation: '' }, false],
			[tools.pipeline_wait, { operation }, true],
			[tools.pipeline_wait, { operation: `${operation}/events` }, false],
		]
		for (const [tool, input, valid] of cases) {
			const schema = tool.input as Extract<Tool.ValueSchema, { readonly '~standard': unknown }>
			const result = await schema['~standard'].validate(input)
			expect([tool.name, input, result.issues === undefined]).toEqual([tool.name, input, valid])
		}
	})

	test.each([
		'review',
		'research',
		'worker',
	])('%s agents cannot mutate even when tools are visible, but may wait', async (agent) => {
		const remote = await fixture()
		const { tools } = await caller(remote.url)
		const operation = remote.create(pr, completed('Done.')).operation
		const mutations = [
			tools.pipeline_review.execute({ pr }, context('call_review', agent)),
			tools.pipeline_continue.execute({ after: operation }, context('call_continue', agent)),
			tools.pipeline_restart.execute({ after: operation }, context('call_restart', agent)),
			tools.pipeline_interrupt.execute({ after: operation }, context('call_interrupt', agent)),
		]
		for (const mutation of mutations)
			expect((await failure(Effect.asVoid(mutation))).metadata).toMatchObject({
				code: 'forbidden',
			})
		expect(remote.requests).toHaveLength(0)

		const waited = await Effect.runPromise(
			tools.pipeline_wait.execute({ operation }, context('call_wait', agent)),
		)
		expect(waited.content).toEqual([{ type: 'text', text: 'Done.' }])
		expect(routes(remote.requests)).toEqual([['GET', '/operations/:op/events']])
	})

	test('session context hides every mutation tool from non-primary agents only', () => {
		const visible = () =>
			Object.fromEntries(
				[...pipelineMutationTools, 'pipeline_wait'].map((name) => [
					name,
					{ description: name, input: {} },
				]),
			)
		const reviewer = { agent: Agent.ID.make('review'), tools: visible() }
		hidePipelineMutations(reviewer)
		expect(Object.keys(reviewer.tools)).toEqual(['pipeline_wait'])
		const primary = { agent: Agent.ID.make('limitless'), tools: visible() }
		hidePipelineMutations(primary)
		expect(Object.keys(primary.tools)).toHaveLength(pipelineMutationTools.length + 1)
	})
})

describe('Pipeline wait', () => {
	test('Completed returns exactly the native final message as content, never earlier output or a wrapper', async () => {
		const remote = await fixture()
		const { tools } = await caller(remote.url)
		const anchor = remote.create(pr, completed('Earlier preamble from the previous turn.'))
		const operation = remote.create(pr, { _tag: 'Queued' }).operation
		const final = '## Verdict\n\nApprove.  \n\n```ts\nconst exact = "  spacing"\n```\n'
		remote.state.onEvents = (response) => {
			remote.update(operation, { _tag: 'Running' })
			response.write(remote.frame(operation))
			remote.update(operation, { _tag: 'Pending' })
			response.write(remote.frame(operation))
			remote.update(operation, completed(final))
			response.write(remote.frame(operation))
		}
		const progress: Array<string> = []
		const result = await Effect.runPromise(
			tools.pipeline_wait.execute(
				{ operation },
				context('call_wait', 'limitless', (update) =>
					Effect.sync(() => {
						if (update.state !== undefined) progress.push(update.state)
					}),
				),
			),
		)
		expect(result.content).toEqual([{ type: 'text', text: final }])
		expect(JSON.stringify(result.content)).not.toContain(
			anchor.state._tag === 'Completed' ? anchor.state.message.text : 'unreachable',
		)
		expect(result.output).toEqual(remote.operations.get(operation))
		expect(progress).toEqual(['Queued', 'Running', 'Pending', 'Completed'])
	})

	test('NDJSON frames decode across arbitrary chunk boundaries and heartbeats', async () => {
		const remote = await fixture()
		const { client } = await caller(remote.url)
		const operation = remote.create(pr, { _tag: 'Preparing' }).operation
		remote.state.onEvents = async (response) => {
			remote.update(operation, { _tag: 'DeliveryUnconfirmed' })
			const split = remote.frame(operation)
			for (const piece of [split.slice(0, 7), split.slice(7, 30), split.slice(30)]) {
				response.write(piece)
				await delay(5)
			}
			response.write('\n \n')
			remote.update(operation, { _tag: 'Running' })
			const running = remote.frame(operation)
			remote.update(operation, { _tag: 'NeedsInput', permissions: 1, forms: 0 })
			response.write(`${running}\n${remote.frame(operation)}`)
		}
		const result = await Effect.runPromise(client.wait({ operation }))
		expect(result).toMatchObject({ operation, state: { _tag: 'NeedsInput', permissions: 1 } })
		expect(remote.state.eventCount).toBe(1)
	})

	test('an already settled initial stream view returns without any JSON read', async () => {
		const remote = await fixture()
		const { tools } = await caller(remote.url)
		const settled: Array<OperationState> = [
			{ _tag: 'NeedsInput', permissions: 0, forms: 1 },
			{ _tag: 'Failed', error: { type: 'ProviderError', message: 'quota' } },
			{ _tag: 'Interrupted', reason: 'user' },
			{ _tag: 'InputCancelled' },
			{ _tag: 'CompletedWithoutMessage' },
			{ _tag: 'Unavailable', message: 'history unreadable' },
			{ _tag: 'CancelledBeforeSend' },
			{ _tag: 'Rejected', message: 'session unavailable' },
		]
		for (const state of settled) {
			const operation = remote.create(pr, state).operation
			const result = await Effect.runPromise(
				tools.pipeline_wait.execute({ operation }, context('call_wait')),
			)
			expect(result.output).toMatchObject({ operation, state })
			expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.output) }])
		}
		expect(remote.state.eventCount).toBe(settled.length)
		expect(new Set(routes(remote.requests).map(([, path]) => path))).toEqual(
			new Set(['/operations/:op/events']),
		)
	})

	test.each([
		['an ended event body', ''],
		['a truncated final frame', '{"operation":'],
	])('%s reconnects the event stream without a JSON read or any submission', async (_name, tail) => {
		const remote = await fixture()
		const operation = remote.create(pr, { _tag: 'Running' }).operation
		remote.state.onEvents = (response, count) => {
			if (count === 1) {
				response.end(tail)
				return
			}
			remote.update(operation, completed('Done.'))
			response.end(remote.frame(operation))
		}
		const { client } = await caller(remote.url)
		const result = await Effect.runPromise(client.wait({ operation }))
		expect(result).toMatchObject({ state: { _tag: 'Completed' } })
		expect(routes(remote.requests)).toEqual([
			['GET', '/operations/:op/events'],
			['GET', '/operations/:op/events'],
		])
	})

	test('a first view that arrives long after the immediate heartbeat still returns the exact final text', async () => {
		const remote = await fixture()
		const { tools } = await caller(remote.url)
		const operation = remote.create(pr, { _tag: 'Running' }).operation
		const final = 'Verdict: approve.\n'
		remote.state.initialView = false
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const waiting = yield* tools.pipeline_wait
					.execute({ operation }, context('call_slow'))
					.pipe(Effect.forkScoped)
				yield* Effect.promise(() => remote.eventOpened)
				yield* TestClock.adjust(nativeEvaluationBudgetMs)
				expect(waiting.pollUnsafe()).toBeUndefined()
				remote.publish(operation, completed(final))
				return yield* Fiber.join(waiting)
			}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
		)
		expect(result.content).toEqual([{ type: 'text', text: final }])
		expect(routes(remote.requests)).toEqual([['GET', '/operations/:op/events']])
	})

	test.each([
		['after', true],
		['before', false],
	])('cancelling a wait %s its initial view releases the event stream without interrupting or closing', async (_name, initialView) => {
		const remote = await fixture()
		const { client } = await caller(remote.url)
		const operation = remote.create(pr, { _tag: 'Running' }).operation
		remote.state.initialView = initialView
		const fiber = Effect.runFork(client.wait({ operation }))
		await remote.eventOpened
		const [subscription] = remote.events.keys()
		const released = signal()
		subscription?.on('close', released.resolve)
		await Effect.runPromise(Fiber.interrupt(fiber))
		await released.promise
		expect(remote.events.size).toBe(0)
		expect(remote.requests.every(({ method }) => method === 'GET')).toBe(true)
	})

	test('a healthy subscription has no total budget', async () => {
		const remote = await fixture()
		const { client } = await caller(remote.url)
		const operation = remote.create(pr, { _tag: 'Running' }).operation
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const opened = yield* Deferred.make<void>()
				remote.state.onEvents = () => Deferred.doneUnsafe(opened, Effect.void)
				const waiting = yield* client.wait({ operation }).pipe(Effect.forkScoped)
				yield* Deferred.await(opened)
				yield* TestClock.adjust('2 hours')
				expect(waiting.pollUnsafe()).toBeUndefined()
				remote.publish(operation, completed('Done.'))
				return yield* Fiber.join(waiting)
			}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
		)
		expect(result).toMatchObject({ state: { _tag: 'Completed' } })
		expect(remote.state.eventCount).toBe(1)
	})

	test('persistent unavailability returns Unavailable without implying the operation did not start', async () => {
		const remote = await fixture()
		const { client } = await caller(remote.url)
		const operation = remote.create(pr, { _tag: 'Running' }).operation
		remote.state.readStatus = 503
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const waiting = yield* client.wait({ operation }).pipe(Effect.forkScoped)
				for (let step = 0; step < 60 && waiting.pollUnsafe() === undefined; step++) {
					yield* Effect.promise(() => delay(5))
					yield* TestClock.adjust('5 seconds')
				}
				return yield* Fiber.join(waiting)
			}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
		)
		expect(result).toMatchObject({ _tag: 'Unavailable', operation })
		if (!('_tag' in result) || result._tag !== 'Unavailable')
			throw new Error('expected Unavailable')
		expect(result.message).toContain('does not show whether the operation started')
		expect(remote.requests.length).toBeGreaterThan(2)
		expect(remote.requests.every(({ method }) => method === 'GET')).toBe(true)
	})

	test.each([
		'initial',
		'later',
	])('an %s streamed view for another operation is Unavailable, never a result', async (position) => {
		const remote = await fixture()
		const { client } = await caller(remote.url)
		const operation = remote.create(pr, { _tag: 'Running' }).operation
		const other = remote.create(pr, completed('Not this operation.')).operation
		remote.state.initialView = position === 'later'
		remote.state.onEvents = (response) => response.write(remote.frame(other))
		const result = await Effect.runPromise(client.wait({ operation }))
		expect(result).toMatchObject({ _tag: 'Unavailable', operation })
		expect(JSON.stringify(result)).not.toContain('Not this operation.')
	})
})

describe('Pipeline HTTP resource deadlines', () => {
	test('the JSON deadline exceeds the native evaluation budget and includes a stalled body', async () => {
		const remote = await fixture()
		const { client } = await caller(remote.url)
		const operation = remote.create(pr).operation
		const started = signal()
		remote.state.handleRequest = (_method, _path, response) => {
			response.writeHead(200, { 'content-type': 'application/json' })
			response.write('{"operation":')
			started.resolve()
			return true
		}
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const reading = yield* Effect.flip(client.read(operation)).pipe(Effect.forkScoped)
				yield* Effect.promise(() => started.promise)
				yield* TestClock.adjust(evaluationResponseDeadlineMs - 1)
				expect(reading.pollUnsafe()).toBeUndefined()
				yield* TestClock.adjust(1)
				return yield* Fiber.join(reading)
			}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
		)
		expect(error.code).toBe('unavailable')
		expect(JSON.stringify(error)).not.toContain(token)
	})

	test.each([
		['handshake', undefined],
		['404 body', 404],
		['409 body', 409],
	] as const)('a stalled event %s is aborted at ten seconds and the stream is retried', async (_part, status) => {
		const remote = await fixture()
		const { client } = await caller(remote.url)
		const operation = remote.create(pr, { _tag: 'Running' }).operation
		const started = signal()
		const closed = signal()
		remote.state.handleRequest = (_method, path, response) => {
			if (!path.endsWith('/events')) return false
			response.on('close', closed.resolve)
			if (status !== undefined) {
				response.writeHead(status, { 'content-type': 'application/json' })
				response.write('{"code":')
			}
			started.resolve()
			return true
		}
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const waiting = yield* client.wait({ operation }).pipe(Effect.forkScoped)
				yield* Effect.promise(() => started.promise)
				yield* TestClock.adjust('10 seconds')
				yield* Effect.promise(() => closed.promise)
				remote.state.handleRequest = () => false
				remote.state.onEvents = (response) => {
					remote.update(operation, completed('Done.'))
					response.end(remote.frame(operation))
				}
				yield* TestClock.adjust(250)
				return yield* Fiber.join(waiting)
			}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
		)
		expect(result).toMatchObject({ state: { _tag: 'Completed' } })
		expect(routes(remote.requests)).toEqual([
			['GET', '/operations/:op/events'],
			['GET', '/operations/:op/events'],
		])
	})
})

describe('Pipeline credential and schema boundary', () => {
	test('configuration rejects credentialed/non-origin/insecure URLs and defaults to disabled', async () => {
		expect(await Effect.runPromise(normalizePipelinePluginConfig({}))).toEqual({ enabled: false })
		for (const url of [
			'http://remote.example',
			'https://user:password@example.com',
			'https://example.com/path',
			'https://example.com?token=hidden',
			'https://example.com#fragment',
		]) {
			const error = await Effect.runPromise(
				Effect.flip(
					normalizePipelinePluginConfig({
						pipeline: { enabled: true, url, tokenFile: '/run/token' },
					}),
				),
			)
			expect(error._tag).toBe('PipelineConfigError')
			expect(JSON.stringify(error)).not.toContain('password')
		}
		expect(
			await Effect.runPromise(
				normalizePipelinePluginConfig({
					pipeline: { enabled: true, url: 'https://pipeline.example/', tokenFile: '/run/token' },
				}),
			),
		).toEqual({ enabled: true, url: 'https://pipeline.example', tokenFile: '/run/token' })
	})

	test('loads only protected runtime token files and keeps the value redacted', async () => {
		const directory = await mkdtemp('/tmp/opencode/pipeline-caller-token-')
		cleanup.push(() => rm(directory, { recursive: true, force: true }))
		const protectedFile = join(directory, 'protected')
		await writeFile(protectedFile, `${token}\n`, { mode: 0o600 })
		const loaded = await Effect.runPromise(readPipelineToken(protectedFile))
		expect(Redacted.value(loaded)).toBe(token)
		expect(JSON.stringify(loaded)).not.toContain(token)
		const exposedFile = join(directory, 'exposed')
		await writeFile(exposedFile, token, { mode: 0o644 })
		expect((await Effect.runPromise(Effect.flip(readPipelineToken(exposedFile))))._tag).toBe(
			'PipelineConfigError',
		)
	})

	test('all caller tools expose portable provider schemas', async () => {
		const remote = await fixture()
		const { tools } = await caller(remote.url)
		expect(Object.keys(tools)).toEqual([
			'pipeline_review',
			'pipeline_continue',
			'pipeline_restart',
			'pipeline_wait',
			'pipeline_interrupt',
		])
		for (const tool of Object.values(tools)) {
			expect(tool.input['~standard'].jsonSchema.input({ target: 'draft-07' })).toMatchObject({
				type: 'object',
			})
			expect(() =>
				JSON.stringify(tool.output?.['~standard'].jsonSchema.output({ target: 'draft-2020-12' })),
			).not.toThrow()
		}
	})
})
