import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Plugin } from '@opencode/plugin/effect'
import type { SessionContext } from '@opencode/plugin/effect/session'
import { Agent } from '@opencode/schema/agent'
import { Tool } from '@opencode/schema/tool'
import { Deferred, Effect, Fiber, Redacted, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { TestClock } from 'effect/testing'
import { afterEach, describe, expect, test } from 'vitest'
import { interruptIntent, resumeIntent, reviewIntent } from '../../pipeline/tasks/intent'
import {
	CommandReceipt,
	type CommandView,
	type DispatchReceipt,
	InterruptRequest,
	ResumeRequest,
	ReviewRequest,
	Task,
} from '../../pipeline/tasks/schema'
import type { NativeObservation } from '../../pipeline/worker/schema'
import { makePipelineClient, WaitInput } from '../tools/pipeline/client'
import { normalizePipelinePluginConfig, readPipelineToken } from '../tools/pipeline/config'
import { restorePipelineContext } from '../tools/pipeline/index'
import { type Admission, makeReceipts, Receipt } from '../tools/pipeline/receipts'
import { pipelineTools } from '../tools/pipeline/tools'
import { testToolContext, testToolExecution } from './execution'

const pr = 'https://github.com/owner/repo/pull/123'
const token = 'fixture-token-not-a-real-secret-123456789'
const nativeSessionId = 'ses_native'
const assignment = {
	workerId: 'worker',
	workerUrl: 'https://worker.example',
	controlDirectory: '/srv/capsule/control',
	storageId: 'storage-worker',
	workspaceId: 'wrk_native',
	directory: '/srv/capsule/checkouts/wrk_native/checkout',
	sessionId: nativeSessionId,
}

function makeTask(request: ReviewRequest = { kind: 'review', pr }) {
	return Task.make({
		id: randomUUID(),
		createdAt: 0,
		request,
		submissions: { _tag: 'Open' },
		placement: { _tag: 'Assigned', assignment },
	})
}

function makeCommand(
	taskId: string,
	kind: CommandReceipt['kind'],
	requestHash: string,
	afterCommandId?: string,
): CommandReceipt {
	const id = randomUUID()
	return CommandReceipt.make({
		id,
		taskId,
		createdAt: 0,
		version: 0,
		kind,
		requestHash,
		...(afterCommandId === undefined ? {} : { afterCommandId }),
		...(kind === 'interrupt' ? {} : { messageId: `msg_${id}` }),
		delivery: { _tag: 'Pending', step: 'send' },
	})
}

function deliver(command: CommandReceipt, delivery: CommandReceipt['delivery']): CommandReceipt {
	return { ...command, version: command.version + 1, delivery }
}

function acknowledged(command: CommandReceipt): CommandReceipt {
	return deliver(command, {
		_tag: 'Acknowledged',
		nativeRef: {
			sessionId: nativeSessionId,
			...(command.messageId === undefined ? {} : { messageId: command.messageId }),
		},
	})
}

const idle: NativeObservation = { _tag: 'Idle' }
const running: NativeObservation = { _tag: 'Running', backgroundJobs: 0 }

type Misroute = 'task' | 'command' | 'relation' | 'placement' | 'nativeSession' | 'nativeMessage'

function misrouted(view: CommandView, field: Misroute): CommandView {
	const command = acknowledged(view.command)
	const valid = { ...view, command, observation: idle }
	switch (field) {
		case 'task': {
			const id = randomUUID()
			return { ...valid, task: { ...view.task, id }, command: { ...command, taskId: id } }
		}
		case 'command':
			return { ...valid, command: { ...command, id: randomUUID() } }
		case 'relation':
			return { ...valid, command: { ...command, taskId: randomUUID() } }
		case 'placement':
			return { ...valid, task: { ...view.task, placement: { _tag: 'Unassigned' } } }
		case 'nativeSession':
			return {
				...valid,
				command: deliver(command, {
					_tag: 'Acknowledged',
					nativeRef: { sessionId: 'ses_other', messageId: `msg_${command.id}` },
				}),
			}
		case 'nativeMessage':
			return {
				...valid,
				command: deliver(command, {
					_tag: 'Acknowledged',
					nativeRef: { sessionId: nativeSessionId, messageId: 'msg_other' },
				}),
			}
	}
}

function durableStorage() {
	const values = new Map<string, Schema.Json>()
	const storage: Plugin.Context['storage'] = {
		get: (key) => Effect.sync(() => values.get(key)),
		set: (key, value) =>
			Effect.sync(() => {
				values.set(key, JSON.parse(JSON.stringify(value)))
			}),
		remove: (key) =>
			Effect.sync(() => {
				values.delete(key)
			}),
		scan: ({ prefix, after, limit = 100 }) =>
			Effect.sync(() => {
				const matches = [...values.entries()]
					.filter(([key]) => key.startsWith(prefix) && (after === undefined || key > after))
					.sort(([a], [b]) => a.localeCompare(b))
				const entries = matches.slice(0, limit).map(([key, value]) => ({ key, value }))
				const last = entries.at(-1)
				return {
					entries,
					...(matches.length > limit && last !== undefined ? { next: last.key } : {}),
				}
			}),
	}
	return { storage, values }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close()
})

function requestSignal() {
	const callbacks = { resolve: () => {} }
	const promise = new Promise<void>((resolve) => {
		callbacks.resolve = resolve
	})
	return { promise, resolve: () => callbacks.resolve() }
}

const decodeJson = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, body: string) =>
	Schema.decodeUnknownSync(Schema.fromJsonString(schema))(body)

async function fixture() {
	const requests: Array<{ method: string; path: string; key: string | undefined; body: string }> =
		[]
	const admissions = new Map<string, { body: string; dispatch: DispatchReceipt }>()
	const commands = new Map<string, CommandReceipt>()
	const events = new Map<ServerResponse, string>()
	const task = makeTask()
	const initial = makeCommand(task.id, 'review', reviewIntent(task.request))
	commands.set(initial.id, initial)
	const state = {
		task,
		observation: { _tag: 'NotObserved' } as NativeObservation,
		loseNextAdmission: false,
		redirect: undefined as string | undefined,
		readStatus: 200,
		eventCount: 0,
		closeCount: 0,
		onEvents: (_response: ServerResponse, _count: number) => {},
		onAdmission: () => {},
		handleRequest: (_method: string, _path: string, _response: ServerResponse) => false,
	}
	const view = (commandId: string): CommandView | undefined => {
		const command = commands.get(commandId)
		if (command === undefined) return undefined
		return { task: state.task, command, observation: state.observation }
	}
	const admittedCommand = (path: string, body: string) => {
		if (path === '/tasks') {
			const request = decodeJson(ReviewRequest, body)
			state.task = makeTask(request)
			return makeCommand(state.task.id, 'review', reviewIntent(request))
		}
		if (path.endsWith('/resume')) {
			const request = decodeJson(ResumeRequest, body)
			const hash = resumeIntent(state.task.id, request)
			return makeCommand(state.task.id, 'resume', hash, request.afterCommandId)
		}
		const request = decodeJson(InterruptRequest, body)
		const hash = interruptIntent(state.task.id, request)
		return makeCommand(state.task.id, 'interrupt', hash, request.afterCommandId)
	}
	const frame = (commandId: string) => `${JSON.stringify(view(commandId))}\n`
	let opened: (() => void) | undefined
	const eventOpened = new Promise<void>((resolve) => {
		opened = resolve
	})
	const server = createServer(async (request, response) => {
		const chunks: Array<Buffer> = []
		for await (const chunk of request) chunks.push(Buffer.from(chunk))
		const body = Buffer.concat(chunks).toString()
		const path = request.url ?? '/'
		const method = request.method ?? 'GET'
		const key =
			typeof request.headers['idempotency-key'] === 'string'
				? request.headers['idempotency-key']
				: undefined
		requests.push({ method, path, key, body })
		if (state.redirect !== undefined) {
			response.writeHead(302, { location: state.redirect }).end()
			return
		}
		if (request.headers.authorization !== `Bearer ${token}`) {
			response.writeHead(401).end()
			return
		}
		if (state.handleRequest(method, path, response)) return
		const json = (value: unknown, status = 200) =>
			response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
		if (method === 'POST' && (path === '/tasks' || /\/(resume|interrupt)$/.test(path))) {
			state.onAdmission()
			const previous = key === undefined ? undefined : admissions.get(key)
			if (previous !== undefined) {
				if (previous.body !== body) {
					response.writeHead(409).end()
					return
				}
				json(previous.dispatch, 202)
				return
			}
			const command = admittedCommand(path, body)
			commands.set(command.id, command)
			const dispatch = { task: state.task, command }
			admissions.set(key ?? '', { body, dispatch })
			if (state.loseNextAdmission) {
				state.loseNextAdmission = false
				response.destroy()
				return
			}
			json(dispatch, 202)
			return
		}
		if (method === 'POST' && path.endsWith('/close')) {
			state.closeCount++
			state.task = { ...state.task, submissions: { _tag: 'Closed' } }
			json(state.task)
			return
		}
		const commandId = path.split('/')[4] ?? ''
		if (path.endsWith('/events')) {
			state.eventCount++
			response.writeHead(200, { 'content-type': 'application/x-ndjson' })
			response.write(`\n${frame(commandId)}`)
			events.set(response, commandId)
			response.on('close', () => events.delete(response))
			state.onEvents(response, state.eventCount)
			opened?.()
			return
		}
		if (state.readStatus !== 200) {
			response.writeHead(state.readStatus).end()
			return
		}
		const current = view(commandId)
		if (current === undefined) response.writeHead(404).end()
		else json(current)
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
	const update = (next: { command?: CommandReceipt; observation?: NativeObservation }) => {
		if (next.command !== undefined) commands.set(next.command.id, next.command)
		if (next.observation !== undefined) state.observation = next.observation
	}
	return {
		state,
		requests,
		admissions,
		commands,
		initial: { taskId: task.id, commandId: initial.id },
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		eventOpened,
		view: (commandId = initial.id) => view(commandId) as CommandView,
		frame,
		update,
		publish: (next: { command?: CommandReceipt; observation?: NativeObservation }) => {
			update(next)
			for (const [response, commandId] of events) response.write(`\n${frame(commandId)}`)
		},
	}
}

async function caller(url: string, durable = durableStorage()) {
	const receipts = await Effect.runPromise(makeReceipts(durable.storage, url))
	const client = await Effect.runPromise(
		makePipelineClient({ url, token: Redacted.make(token) }, receipts).pipe(
			Effect.provide(FetchHttpClient.layer),
		),
	)
	return { client, receipts, durable, tools: pipelineTools(client) }
}

function context(callId: string, agent = 'limitless') {
	return {
		...testToolContext(testToolExecution('/fixture', 'ses_pipeline')),
		agent: Agent.ID.make(agent),
		id: Schema.decodeUnknownSync(Tool.CallID)(callId),
	}
}

function acceptedAdmission(admission: Admission | undefined) {
	if (admission?._tag !== 'Accepted') throw new Error('expected an accepted admission')
	return admission
}

function contextEvent(agent = 'limitless') {
	const event: Pick<SessionContext, 'sessionID' | 'agent' | 'system' | 'tools'> = {
		sessionID: context('call_context').sessionID,
		agent: Agent.ID.make(agent),
		system: [],
		tools: {},
	}
	return event
}

describe('durable Pipeline caller admission', () => {
	test('regenerated call IDs, concurrent requests, and plugin recreation recover one sticky review whose accepted receipt drops the body', async () => {
		const remote = await fixture()
		const first = await caller(remote.url)
		const admissionStates: Array<Array<Schema.Json>> = []
		remote.state.onAdmission = () => {
			admissionStates.push([...first.durable.values.values()])
		}
		const results = await Effect.runPromise(
			Effect.all(
				[
					first.tools.pipeline_review.execute({ pr }, context('call_one')),
					first.tools.pipeline_review.execute({ pr: `${pr}/` }, context('call_two')),
				],
				{ concurrency: 'unbounded' },
			),
		)
		expect(results[0].output).toMatchObject({ _tag: 'Accepted' })
		expect(results[1].output).toEqual(results[0].output)
		expect(remote.admissions.size).toBe(1)
		expect(admissionStates[0]).toEqual([
			expect.objectContaining({ _tag: 'Prepared', body: JSON.stringify({ kind: 'review', pr }) }),
		])
		const [stored] = [...first.durable.values.values()]
		expect(stored).toMatchObject({ _tag: 'Accepted', pr, operation: 'review' })
		expect(Object.keys(stored as object)).not.toEqual(
			expect.arrayContaining([expect.stringMatching(/^(body|key|path)$/)]),
		)

		const accepted = acceptedAdmission(results[0].output)
		remote.update({ command: acknowledged(remote.view(accepted.commandId).command) })
		const restarted = await caller(remote.url, first.durable)
		const recovered = await Effect.runPromise(
			restarted.tools.pipeline_review.execute({ pr }, context('call_three')),
		)
		expect(recovered.output).toEqual(accepted)
		expect(remote.admissions.size).toBe(1)
		expect(await Effect.runPromise(restarted.receipts.list('ses_pipeline'))).toHaveLength(1)
	})

	test('a lost response leaves a Prepared receipt and recovery reuses its exact key and body after restart', async () => {
		const remote = await fixture()
		const first = await caller(remote.url)
		remote.state.loseNextAdmission = true
		const unknown = await Effect.runPromise(first.client.review('session', { pr }))
		expect(unknown._tag).toBe('AdmissionUnknown')
		expect([...first.durable.values.values()]).toEqual([
			expect.objectContaining({ _tag: 'Prepared' }),
		])
		const second = await caller(remote.url, first.durable)
		const result = await Effect.runPromise(second.client.review('session', { pr }))
		expect(result._tag).toBe('Accepted')
		expect(remote.admissions.size).toBe(1)
		expect(remote.requests[1]).toEqual(remote.requests[0])
		expect([...first.durable.values.values()]).toEqual([
			expect.objectContaining({ _tag: 'Accepted' }),
		])
	})

	test.each([
		401, 403, 404,
	])('a %s refusal of a retry after a lost committed response keeps the Prepared receipt for exact recovery', async (status) => {
		const remote = await fixture()
		const local = await caller(remote.url)
		remote.state.loseNextAdmission = true
		expect((await Effect.runPromise(local.client.review('session', { pr })))._tag).toBe(
			'AdmissionUnknown',
		)
		const prepared = [...local.durable.values.values()]
		expect(prepared).toEqual([expect.objectContaining({ _tag: 'Prepared' })])

		remote.state.handleRequest = (_method, _path, response) => {
			response.writeHead(status).end()
			return true
		}
		const refused = await Effect.runPromise(Effect.flip(local.client.review('session', { pr })))
		expect(refused.code).toBe('refused')
		expect([...local.durable.values.values()]).toEqual(prepared)

		remote.state.handleRequest = () => false
		const restarted = await caller(remote.url, local.durable)
		const recovered = await Effect.runPromise(restarted.client.review('session', { pr }))
		const [committed] = [...remote.admissions.values()]
		expect(acceptedAdmission(recovered)).toMatchObject({
			taskId: committed?.dispatch.task.id,
			commandId: committed?.dispatch.command.id,
		})
		expect(remote.admissions.size).toBe(1)
		expect(remote.requests).toHaveLength(3)
		expect(remote.requests[1]).toEqual(remote.requests[0])
		expect(remote.requests[2]).toEqual(remote.requests[0])
	})

	test('restored context shows recovery requests for Prepared receipts, only references for Accepted ones, and hides mutations from reviewers', async () => {
		const remote = await fixture()
		const first = await caller(remote.url)
		const message = 'Please verify the fix with the retained checkout.'
		remote.state.loseNextAdmission = true
		await Effect.runPromise(
			first.client.resume('ses_pipeline', {
				...remote.initial,
				afterCommandId: remote.initial.commandId,
				message,
			}),
		)
		const restarted = await caller(remote.url, first.durable)
		const prepared = contextEvent()
		await Effect.runPromise(restorePipelineContext(restarted.receipts, prepared))
		const preparedText = JSON.stringify(prepared.system)
		expect(preparedText).toContain('pipeline_resume')
		expect(preparedText).toContain(message)
		expect(preparedText).not.toContain(remote.requests[0]?.key)
		expect(preparedText).not.toContain(token)

		await Effect.runPromise(
			restarted.client.resume('ses_pipeline', {
				taskId: remote.initial.taskId,
				afterCommandId: remote.initial.commandId,
				message,
			}),
		)
		const accepted = contextEvent()
		await Effect.runPromise(restorePipelineContext(restarted.receipts, accepted))
		const acceptedText = JSON.stringify(accepted.system)
		const [command] = [...remote.admissions.values()].map(({ dispatch }) => dispatch.command.id)
		expect(acceptedText).toContain(command)
		expect(acceptedText).toContain(remote.initial.commandId)
		expect(acceptedText).not.toContain(message)

		const reviewer = {
			...contextEvent('review'),
			tools: {
				pipeline_review: { description: 'review', input: {} },
				pipeline_interrupt: { description: 'interrupt', input: {} },
				pipeline_wait: { description: 'wait', input: {} },
			},
		}
		await Effect.runPromise(restorePipelineContext(restarted.receipts, reviewer))
		expect(Object.keys(reviewer.tools)).toEqual(['pipeline_wait'])
		expect(reviewer.system).toHaveLength(0)
	})

	test('sticky review input conflicts, and only an explicit predecessor creates one fresh task', async () => {
		const remote = await fixture()
		const local = await caller(remote.url)
		const first = await Effect.runPromise(local.client.review('session', { pr }))
		if (first._tag !== 'Accepted') throw new Error('fixture admission failed')
		const conflict = await Effect.runPromise(
			Effect.flip(local.client.review('session', { pr, system: 'aarch64-linux' })),
		)
		expect(conflict.code).toBe('receipt_conflict')
		expect(remote.requests).toHaveLength(1)
		const fresh = await Effect.runPromise(
			local.client.review('session', { pr, afterTaskId: first.taskId }),
		)
		const repeated = await Effect.runPromise(
			local.client.review('session', { pr, afterTaskId: first.taskId }),
		)
		expect(fresh).toEqual(repeated)
		expect(await Effect.runPromise(local.client.review('session', { pr }))).toEqual(fresh)
		expect(fresh).not.toMatchObject({ taskId: first.taskId })
		expect(remote.admissions.size).toBe(2)
		const invalidPredecessor = await Effect.runPromise(
			Effect.flip(local.client.review('session', { pr, afterTaskId: randomUUID() })),
		)
		expect(invalidPredecessor.code).toBe('receipt_conflict')
	})

	test('an explicitly fresh Prepared receipt remains the current receipt across restart', async () => {
		const remote = await fixture()
		const local = await caller(remote.url)
		const first = await Effect.runPromise(local.client.review('session', { pr }))
		if (first._tag !== 'Accepted') throw new Error('fixture admission failed')
		remote.state.loseNextAdmission = true
		const fresh = await Effect.runPromise(
			local.client.review('session', { pr, afterTaskId: first.taskId }),
		)
		expect(fresh).toMatchObject({
			_tag: 'AdmissionUnknown',
			receipt: { afterTaskId: first.taskId },
		})
		const restarted = await caller(remote.url, local.durable)
		const recovered = await Effect.runPromise(restarted.client.review('session', { pr }))
		expect(recovered._tag).toBe('Accepted')
		expect(recovered).not.toMatchObject({ taskId: first.taskId })
		expect(remote.admissions.size).toBe(2)
		expect(remote.requests[2]).toEqual(remote.requests[1])
	})

	test('resume recovers its anchored command across regenerated call IDs and rejects a changed message without another POST', async () => {
		const remote = await fixture()
		const local = await caller(remote.url)
		const input = {
			taskId: remote.initial.taskId,
			afterCommandId: remote.initial.commandId,
			message: 'Please verify the fix.',
		}
		remote.state.loseNextAdmission = true
		const unknown = await Effect.runPromise(
			local.tools.pipeline_resume.execute(input, context('call_one')),
		)
		expect(unknown.output?._tag).toBe('AdmissionUnknown')
		const restarted = await caller(remote.url, local.durable)
		const accepted = await Effect.runPromise(
			restarted.tools.pipeline_resume.execute(input, context('call_two')),
		)
		expect(acceptedAdmission(accepted.output)).toMatchObject({
			taskId: input.taskId,
			receipt: { operation: 'resume', afterCommandId: input.afterCommandId },
		})
		expect(
			(
				await Effect.runPromise(
					restarted.tools.pipeline_resume.execute(input, context('call_three')),
				)
			).output,
		).toEqual(accepted.output)
		const changed = await Effect.runPromise(
			Effect.flip(
				restarted.tools.pipeline_resume.execute(
					{ ...input, message: 'A different instruction' },
					context('call_four'),
				),
			),
		)
		expect(changed.metadata).toMatchObject({ code: 'receipt_conflict' })
		expect(remote.admissions.size).toBe(1)
		expect(remote.requests).toHaveLength(2)
		expect(remote.requests[1]).toEqual(remote.requests[0])
	})

	test('interrupt returns a dispatch receipt rather than a stop claim, and close is a separate logical mutation that deletes nothing', async () => {
		const remote = await fixture()
		const local = await caller(remote.url)
		remote.update({
			command: acknowledged(remote.view().command),
			observation: running,
		})
		const input = { taskId: remote.initial.taskId, afterCommandId: remote.initial.commandId }
		const interrupted = await Effect.runPromise(
			local.tools.pipeline_interrupt.execute(input, context('call_interrupt')),
		)
		expect(interrupted.output).toMatchObject({
			_tag: 'Accepted',
			taskId: input.taskId,
			receipt: { operation: 'interrupt', afterCommandId: input.afterCommandId },
		})
		const { commandId } = acceptedAdmission(interrupted.output)
		expect(commandId).not.toBe(input.afterCommandId)
		expect(remote.commands.get(commandId)).toMatchObject({
			kind: 'interrupt',
			delivery: { _tag: 'Pending' },
		})
		expect(
			(
				await Effect.runPromise(
					local.tools.pipeline_interrupt.execute(input, context('call_interrupt_again')),
				)
			).output,
		).toEqual(interrupted.output)

		const receipts = [...local.durable.values.entries()]
		const closed = await Effect.runPromise(
			local.tools.pipeline_close.execute({ taskId: input.taskId }, context('call_close')),
		)
		expect(closed.output).toMatchObject({
			id: input.taskId,
			submissions: { _tag: 'Closed' },
			placement: { _tag: 'Assigned', assignment },
		})
		expect(remote.requests.map(({ method, path }) => ({ method, path }))).toEqual([
			{ method: 'POST', path: `/tasks/${input.taskId}/interrupt` },
			{ method: 'POST', path: `/tasks/${input.taskId}/close` },
		])
		expect(remote.state.closeCount).toBe(1)
		expect(remote.state.observation).toEqual(running)
		expect([...local.durable.values.entries()]).toEqual(receipts)
	})

	test.each([
		'review',
		'research',
		'worker',
	])('denies %s mutations at execution even if tools are visible', async (agent) => {
		const remote = await fixture()
		const local = await caller(remote.url)
		const { taskId, commandId } = remote.initial
		const operations = [
			local.tools.pipeline_review
				.execute({ pr }, context('call_review', agent))
				.pipe(Effect.asVoid),
			local.tools.pipeline_resume
				.execute(
					{ taskId, afterCommandId: commandId, message: 'again' },
					context('call_resume', agent),
				)
				.pipe(Effect.asVoid),
			local.tools.pipeline_interrupt
				.execute({ taskId, afterCommandId: commandId }, context('call_interrupt', agent))
				.pipe(Effect.asVoid),
			local.tools.pipeline_close
				.execute({ taskId }, context('call_close', agent))
				.pipe(Effect.asVoid),
		]
		for (const operation of operations)
			expect((await Effect.runPromise(Effect.flip(operation))).metadata).toMatchObject({
				code: 'forbidden',
			})
		expect(remote.requests).toHaveLength(0)
		expect(local.durable.values.size).toBe(0)
		const read = await Effect.runPromise(
			local.tools.pipeline_wait.execute(
				{ taskId, commandId, timeoutMs: 0 },
				context('call_wait', agent),
			),
		)
		expect(read.output?._tag).toBe('Pending')
	})
})

describe('foreground Pipeline wait', () => {
	test('the default wait has no total budget and leaves a healthy event body open beyond an hour', async () => {
		const remote = await fixture()
		const { client } = await caller(remote.url)
		expect(
			Schema.decodeUnknownSync(WaitInput)({ ...remote.initial, timeoutMs: 3600000 }).timeoutMs,
		).toBe(3600000)
		remote.state.onEvents = (response) => {
			remote.update({ command: acknowledged(remote.view().command), observation: running })
			response.write(remote.frame(remote.initial.commandId))
		}
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ready = yield* Deferred.make<void>()
				const completed = yield* Deferred.make<void>()
				const waiting = yield* client
					.wait(remote.initial, (update) => {
						if (update.status !== 'Acknowledged/Running') return Effect.void
						return Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
					})
					.pipe(
						Effect.tap(() => Deferred.succeed(completed, undefined)),
						Effect.forkScoped,
					)
				yield* Deferred.await(ready)
				yield* TestClock.adjust('1 hour')
				expect(yield* Deferred.isDone(completed)).toBe(false)
				expect(remote.requests).toHaveLength(2)
				remote.publish({ observation: idle })
				return yield* Fiber.join(waiting)
			}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
		)
		expect(result).toMatchObject({ _tag: 'Observed', view: { observation: idle } })
		expect(remote.requests.every((request) => request.method === 'GET')).toBe(true)
	})

	test('zero timeout reads once and reports Observed only for acknowledged native settlement or dispatch-only finishes', async () => {
		const remote = await fixture()
		const { client } = await caller(remote.url)
		const input = { ...remote.initial, timeoutMs: 0 }
		const command = remote.view().command
		const cases: Array<[CommandReceipt, NativeObservation, string]> = [
			[command, idle, 'Pending'],
			[deliver(command, { _tag: 'Unconfirmed' }), idle, 'Pending'],
			[deliver(command, { _tag: 'Unconfirmed' }), { _tag: 'InputCancelled' }, 'Pending'],
			[acknowledged(command), running, 'Pending'],
			[acknowledged(command), { _tag: 'Pending', messageIds: ['msg_queued'] }, 'Pending'],
			[acknowledged(command), { _tag: 'Unavailable', message: 'worker offline' }, 'Pending'],
			[acknowledged(command), idle, 'Observed'],
			[
				acknowledged(command),
				{ _tag: 'NeedsInput', permissionIds: ['per_1'], formIds: [] },
				'Observed',
			],
			[acknowledged(command), { _tag: 'InputCancelled' }, 'Observed'],
			[deliver(command, { _tag: 'CancelledBeforeSend' }), running, 'Observed'],
			[
				deliver(command, {
					_tag: 'Rejected',
					reason: { code: 'session_unavailable', message: 'gone' },
				}),
				{ _tag: 'NotObserved' },
				'Observed',
			],
		]
		for (const [next, observation, expected] of cases) {
			remote.update({ command: next, observation })
			const result = await Effect.runPromise(client.wait(input))
			expect([next.delivery._tag, observation._tag, result._tag]).toEqual([
				next.delivery._tag,
				observation._tag,
				expected,
			])
		}
		expect(remote.requests).toHaveLength(cases.length)
		expect(remote.state.eventCount).toBe(0)
	})

	test('stream updates through Unconfirmed delivery report progress only on changes and ignore heartbeats', async () => {
		const remote = await fixture()
		const { client } = await caller(remote.url)
		const progress: Array<string> = []
		const waiting = Effect.runPromise(
			client.wait({ ...remote.initial, timeoutMs: 3000 }, (update) =>
				Effect.sync(() => {
					if (update.status !== undefined) progress.push(update.status)
				}),
			),
		)
		await remote.eventOpened
		const command = remote.view().command
		remote.publish({ observation: { _tag: 'NotObserved' } })
		remote.publish({ command: deliver(command, { _tag: 'Unconfirmed' }), observation: idle })
		remote.publish({ command: acknowledged(command), observation: running })
		remote.publish({ observation: idle })
		expect(await waiting).toMatchObject({ _tag: 'Observed' })
		expect(progress).toEqual([
			'Pending/NotObserved',
			'Unconfirmed/Idle',
			'Acknowledged/Running',
			'Acknowledged/Idle',
		])
		expect(remote.requests.map((request) => request.path.endsWith('/events'))).toEqual([
			false,
			true,
		])
	})

	test('disconnect reconnects with a durable read and does not resubmit', async () => {
		const remote = await fixture()
		remote.state.onEvents = (response, count) => {
			if (count === 1) {
				response.end()
				return
			}
			remote.update({ command: acknowledged(remote.view().command), observation: idle })
			response.end(remote.frame(remote.initial.commandId))
		}
		const { client } = await caller(remote.url)
		const result = await Effect.runPromise(client.wait({ ...remote.initial, timeoutMs: 3000 }))
		expect(result._tag).toBe('Observed')
		expect(remote.requests.map(({ method, path }) => [method, path.endsWith('/events')])).toEqual([
			['GET', false],
			['GET', true],
			['GET', false],
			['GET', true],
		])
	})

	test('a truncated final NDJSON frame reconnects through a durable read without resubmitting', async () => {
		const remote = await fixture()
		remote.state.onEvents = (response, count) => {
			if (count === 1) {
				response.end('{"task":')
				return
			}
			remote.update({ command: acknowledged(remote.view().command), observation: idle })
			response.end(remote.frame(remote.initial.commandId))
		}
		const { client } = await caller(remote.url)
		const result = await Effect.runPromise(client.wait(remote.initial))
		expect(result._tag).toBe('Observed')
		expect(remote.requests.map(({ method, path }) => [method, path.endsWith('/events')])).toEqual([
			['GET', false],
			['GET', true],
			['GET', false],
			['GET', true],
		])
	})

	test('timeout and interruption detach their streams without interrupt, close, or admission', async () => {
		const remote = await fixture()
		const { client } = await caller(remote.url)
		remote.update({ command: acknowledged(remote.view().command), observation: running })
		const fiber = Effect.runFork(client.wait(remote.initial))
		await remote.eventOpened
		await Effect.runPromise(Fiber.interrupt(fiber))
		expect(
			await Effect.runPromise(client.wait({ ...remote.initial, timeoutMs: 100 })),
		).toMatchObject({ _tag: 'Pending', view: { observation: running } })
		expect(remote.requests.every((request) => request.method === 'GET')).toBe(true)
		expect(remote.state.closeCount).toBe(0)
	})

	test('unreadable state is Unavailable, not a failed command or a new admission', async () => {
		const remote = await fixture()
		remote.state.readStatus = 503
		const { client } = await caller(remote.url)
		const result = await Effect.runPromise(client.wait({ ...remote.initial, timeoutMs: 0 }))
		expect(result).toMatchObject({ _tag: 'Unavailable', ...remote.initial })
		expect(remote.requests).toHaveLength(1)
	})
})

describe('Pipeline response identity validation', () => {
	const misroutes: Array<Misroute> = [
		'task',
		'command',
		'relation',
		'placement',
		'nativeSession',
		'nativeMessage',
	]

	test.each(misroutes)('a read with a misrouted %s is Unavailable', async (field) => {
		const remote = await fixture()
		const { client } = await caller(remote.url)
		const invalid = misrouted(remote.view(), field)
		remote.state.handleRequest = (_method, _path, response) => {
			response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(invalid))
			return true
		}
		expect((await Effect.runPromise(client.wait({ ...remote.initial, timeoutMs: 0 })))._tag).toBe(
			'Unavailable',
		)
	})

	test.each(
		misroutes,
	)('cannot observe the requested command using a streamed misrouted %s', async (field) => {
		const remote = await fixture()
		const { client } = await caller(remote.url)
		const invalid = misrouted(remote.view(), field)
		remote.state.onEvents = (response) => {
			response.write(`${JSON.stringify(invalid)}\n`)
		}
		const progress: Array<string> = []
		const result = await Effect.runPromise(
			client.wait(remote.initial, (update) =>
				Effect.sync(() => {
					if (update.status !== undefined) progress.push(update.status)
				}),
			),
		)
		expect(result).toMatchObject({
			_tag: 'Unavailable',
			view: { command: { id: remote.initial.commandId } },
		})
		expect(progress).toEqual(['Pending/NotObserved'])
		expect(remote.requests).toHaveLength(2)
	})

	test.each([
		'pr',
		'relation',
		'hash',
	] as const)('does not accept a review receipt with a mismatched %s response', async (field) => {
		const remote = await fixture()
		const local = await caller(remote.url)
		const current = remote.view()
		const invalid = (() => {
			switch (field) {
				case 'pr':
					return {
						task: {
							...current.task,
							request: { kind: 'review', pr: 'https://github.com/other/repo/pull/456' },
						},
						command: current.command,
					}
				case 'relation':
					return { task: current.task, command: { ...current.command, taskId: randomUUID() } }
				case 'hash':
					return {
						task: current.task,
						command: {
							...current.command,
							requestHash: reviewIntent({ kind: 'review', pr, system: 'aarch64-linux' }),
						},
					}
			}
		})()
		remote.state.handleRequest = (_method, _path, response) => {
			response.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify(invalid))
			return true
		}
		expect((await Effect.runPromise(local.client.review('session', { pr })))._tag).toBe(
			'AdmissionUnknown',
		)
		expect([...local.durable.values.values()]).toEqual([
			expect.objectContaining({ _tag: 'Prepared' }),
		])
	})

	test.each([
		'task',
		'anchor',
		'kind',
		'message',
	] as const)('does not accept a resume receipt with a different %s', async (field) => {
		const remote = await fixture()
		const local = await caller(remote.url)
		const input = {
			taskId: remote.initial.taskId,
			afterCommandId: remote.initial.commandId,
			message: 'continue',
		}
		const other = makeTask()
		const { task } = remote.view()
		const hash = resumeIntent(input.taskId, input)
		const dispatch = (() => {
			switch (field) {
				case 'task':
					return {
						task: other,
						command: makeCommand(other.id, 'resume', hash, input.afterCommandId),
					}
				case 'anchor':
					return { task, command: makeCommand(input.taskId, 'resume', hash, randomUUID()) }
				case 'kind':
					return {
						task,
						command: makeCommand(input.taskId, 'interrupt', hash, input.afterCommandId),
					}
				case 'message': {
					const changed = resumeIntent(input.taskId, {
						...input,
						message: 'a different instruction',
					})
					return {
						task,
						command: makeCommand(input.taskId, 'resume', changed, input.afterCommandId),
					}
				}
			}
		})()
		remote.state.handleRequest = (_method, _path, response) => {
			response.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify(dispatch))
			return true
		}
		expect((await Effect.runPromise(local.client.resume('session', input)))._tag).toBe(
			'AdmissionUnknown',
		)
		expect([...local.durable.values.values()]).toEqual([
			expect.objectContaining({ _tag: 'Prepared' }),
		])
	})

	test('does not accept an interrupt receipt whose request hash names another intent', async () => {
		const remote = await fixture()
		const local = await caller(remote.url)
		const input = { taskId: remote.initial.taskId, afterCommandId: remote.initial.commandId }
		const changed = interruptIntent(randomUUID(), input)
		const dispatch = {
			task: remote.view().task,
			command: makeCommand(input.taskId, 'interrupt', changed, input.afterCommandId),
		}
		remote.state.handleRequest = (_method, _path, response) => {
			response.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify(dispatch))
			return true
		}
		expect((await Effect.runPromise(local.client.interrupt('session', input)))._tag).toBe(
			'AdmissionUnknown',
		)
		expect([...local.durable.values.values()]).toEqual([
			expect.objectContaining({ _tag: 'Prepared' }),
		])
	})
})

describe('Pipeline HTTP resource deadlines', () => {
	test('the ten-second JSON deadline includes a stalled body after successful headers', async () => {
		const remote = await fixture()
		const { client } = await caller(remote.url)
		const started = requestSignal()
		remote.state.handleRequest = (_method, _path, response) => {
			response.writeHead(200, { 'content-type': 'application/json' })
			response.write('{"task":')
			started.resolve()
			return true
		}
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const reading = yield* Effect.flip(client.read(remote.initial)).pipe(Effect.forkScoped)
				yield* Effect.promise(() => started.promise)
				yield* TestClock.adjust('10 seconds')
				return yield* Fiber.join(reading)
			}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
		)
		expect(error.code).toBe('unavailable')
		expect(JSON.stringify(error)).not.toContain(token)
	})

	test('a stalled event handshake is aborted at ten seconds and retried through a durable read', async () => {
		const remote = await fixture()
		const { client } = await caller(remote.url)
		const started = requestSignal()
		const closed = requestSignal()
		remote.state.handleRequest = (_method, path, response) => {
			if (!path.endsWith('/events')) return false
			response.on('close', closed.resolve)
			started.resolve()
			return true
		}
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const waiting = yield* client.wait(remote.initial).pipe(Effect.forkScoped)
				yield* Effect.promise(() => started.promise)
				yield* TestClock.adjust('10 seconds')
				yield* Effect.promise(() => closed.promise)
				remote.state.handleRequest = () => false
				remote.state.onEvents = (response) => {
					remote.update({ command: acknowledged(remote.view().command), observation: idle })
					response.end(remote.frame(remote.initial.commandId))
				}
				yield* TestClock.adjust(250)
				return yield* Fiber.join(waiting)
			}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
		)
		expect(result._tag).toBe('Observed')
		expect(remote.requests.map(({ method, path }) => [method, path.endsWith('/events')])).toEqual([
			['GET', false],
			['GET', true],
			['GET', false],
			['GET', true],
		])
	})
})

describe('Pipeline credential and schema boundary', () => {
	test('credentialed requests never follow redirects or expose the token in errors or receipts', async () => {
		const destination = await fixture()
		const remote = await fixture()
		remote.state.redirect = destination.url
		const local = await caller(remote.url)
		const result = await Effect.runPromise(local.client.review('session', { pr }))
		expect(result._tag).toBe('AdmissionUnknown')
		expect(destination.requests).toHaveLength(0)
		expect(JSON.stringify(result)).not.toContain(token)
		expect(JSON.stringify([...local.durable.values.values()])).not.toContain(token)
	})

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

	test('all caller tools expose portable provider schemas and receipts remain schema-decodable', async () => {
		const remote = await fixture()
		const local = await caller(remote.url)
		expect(Object.keys(local.tools)).toEqual([
			'pipeline_review',
			'pipeline_resume',
			'pipeline_wait',
			'pipeline_interrupt',
			'pipeline_close',
		])
		for (const tool of Object.values(local.tools)) {
			expect(tool.input['~standard'].jsonSchema.input({ target: 'draft-07' })).toMatchObject({
				type: 'object',
			})
			expect(() =>
				JSON.stringify(tool.output?.['~standard'].jsonSchema.output({ target: 'draft-2020-12' })),
			).not.toThrow()
		}
		await Effect.runPromise(local.client.review('session', { pr }))
		expect(Schema.decodeUnknownSync(Receipt)([...local.durable.values.values()][0])._tag).toBe(
			'Accepted',
		)
	})
})
