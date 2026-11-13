import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { NodeServices } from '@effect/platform-node'
import { Deferred, Effect, Layer, Schema } from 'effect'
import { HttpRouter, HttpServer } from 'effect/http'
import { expect, test } from 'vitest'
import { PipelineConfig } from '../config'
import { Scheduler } from '../scheduler'
import { routesLayer } from '../server'
import { Tasks } from '../tasks/service'
import { WorkerError } from '../worker/schema'
import { OperationReceipt, OperationView } from '../workflow'
import { coordinator, review, settings } from './fixtures'

async function harness() {
	const directory = await mkdtemp('/tmp/opencode/pipeline-api-')
	const apiTokenFile = path.join(directory, 'api-token')
	const token = 'synthetic-pipeline-token-for-isolated-tests'
	await writeFile(apiTokenFile, token, { mode: 0o600 })
	const native = coordinator()
	const tasks = await native.runtime.runPromise(Tasks)
	const { handler, dispose } = HttpRouter.toWebHandler(
		routesLayer.pipe(
			Layer.provide(Layer.succeed(Tasks, tasks)),
			Layer.provide(NodeServices.layer),
			Layer.provide(Layer.succeed(PipelineConfig, { ...settings, apiTokenFile })),
			Layer.provide(HttpServer.layerServices),
		),
	)
	const request = (url: string, method = 'GET', body?: unknown) =>
		handler(
			new Request(`http://localhost${url}`, {
				method,
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		)
	const tick = () => native.runtime.runPromise(Effect.flatMap(Scheduler, (s) => s.tick()))
	return {
		...native,
		handler,
		request,
		tick,
		dispose: async () => {
			await dispose()
			await native.runtime.dispose()
			await rm(directory, { recursive: true, force: true })
		},
	}
}

const receipt = async (response: Response) =>
	Schema.decodeUnknownSync(OperationReceipt)(await response.json())

test('authenticated workflow routes recover semantic actions without caller keys and reject obsolete task routes', async () => {
	const { handler, request, tick, control, dispose } = await harness()
	try {
		const id = '11111111-1111-4111-8111-000000000001'
		for (const [url, method] of [
			['/health', 'GET'],
			['/reviews', 'POST'],
			[`/operations/${id}`, 'GET'],
			[`/operations/${id}/events`, 'GET'],
			...['continue', 'restart', 'interrupt'].map(
				(action) => [`/operations/${id}/${action}`, 'POST'] as const,
			),
		] as const) {
			expect((await handler(new Request(`http://localhost${url}`, { method }))).status).toBe(401)
		}
		expect((await request('/tasks', 'POST', { kind: 'review', ...review() })).status).toBe(404)
		expect((await request('/reviews', 'POST', { pr: 'not-a-pr' })).status).toBe(400)
		const responses = await Promise.all([
			request('/reviews', 'POST', review()),
			request('/reviews', 'POST', review()),
		])
		expect(responses.map((response) => response.status)).toEqual([202, 202])
		const first = await receipt(responses[0])
		expect(await receipt(responses[1])).toEqual(first)
		expect(Object.keys(first).sort()).toEqual(['closed', 'operation', 'pr'])
		const base = `/operations/${first.operation}`
		expect((await request(`${base}/continue`, 'POST')).status).toBe(409)
		await tick()
		expect((await request(`${base}/continue`, 'POST')).status).toBe(409)
		control.observation = { _tag: 'Idle' }
		control.result = {
			_tag: 'Completed',
			message: { id: 'msg_final', text: 'Exact native response\n\nSecond part.' },
		}
		const resumed = await receipt(await request(`${base}/continue`, 'POST'))
		expect(resumed.operation).not.toBe(first.operation)
		expect(await receipt(await request(`${base}/continue`, 'POST'))).toEqual(resumed)
		expect((await request(`${base}/close`, 'POST')).status).toBe(404)
		expect((await request(`/operations/${resumed.operation}/close`, 'POST')).status).toBe(404)
		expect(await receipt(await request('/reviews', 'POST', review()))).toEqual(resumed)
		expect((await request(`/operations/${id}`)).status).toBe(404)
		expect((await request('/operations/invalid')).status).toBe(400)
	} finally {
		await dispose()
	}
})

test('NDJSON carries the native result, not merely idle, and reconnecting retains the operation result', async () => {
	const { request, tick, control, dispose } = await harness()
	try {
		const first = await receipt(await request('/reviews', 'POST', review()))
		const url = `/operations/${first.operation}/events`
		const response = await request(url)
		expect(response.headers.get('content-type')).toContain('application/x-ndjson')
		const reader = response.body?.getReader()
		if (reader === undefined) throw new Error('Missing event stream')
		const decoder = new TextDecoder()
		let text = ''
		while (text.trim() === '') text += decoder.decode((await reader.read()).value, { stream: true })
		await tick()
		control.observation = { _tag: 'Idle' }
		control.result = {
			_tag: 'Completed',
			message: { id: 'msg_final', text: 'Native final message.' },
		}
		await tick()
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
			text += decoder.decode(chunk.value, { stream: true })
		const views = text
			.split('\n')
			.filter(Boolean)
			.map((line) => Schema.decodeUnknownSync(OperationView)(JSON.parse(line)))
		expect(views[0]?.state._tag).toBe('Queued')
		expect(views.at(-1)).toMatchObject({ operation: first.operation, state: control.result })
		expect((await (await request(url)).text()).trim().split('\n')).toHaveLength(1)
	} finally {
		await dispose()
	}
})

test('event transport opens before slow native reconstruction and cancellation releases that read', async () => {
	const { request, tick, control, runtime, dispose } = await harness()
	try {
		const first = await receipt(await request('/reviews', 'POST', review()))
		await tick()
		control.resultGate = await runtime.runPromise(Deferred.make<void>())
		const response = await request(`/operations/${first.operation}/events`)
		const reader = response.body?.getReader()
		if (reader === undefined) throw new Error('Missing event stream')
		expect(new TextDecoder().decode((await reader.read()).value)).toBe('\n')
		await runtime.runPromise(Deferred.await(control.resultStarted))
		await reader.cancel()
		expect(control.resultsInterrupted).toBe(1)
	} finally {
		await dispose()
	}
})

test('a temporary native read failure keeps the event stream open until the result is recovered', async () => {
	const { request, tick, control, calls, dispose } = await harness()
	try {
		const first = await receipt(await request('/reviews', 'POST', review()))
		await tick()
		control.resultErrors.push(
			WorkerError.make({ code: 'unavailable', message: 'Synthetic timeout' }),
		)
		control.result = {
			_tag: 'Completed',
			message: { id: 'msg_final', text: 'Recovered native final message.' },
		}
		const response = await request(`/operations/${first.operation}/events`)
		const text = await response.text()
		const views = text
			.trim()
			.split('\n')
			.map((line) => Schema.decodeUnknownSync(OperationView)(JSON.parse(line)))
		expect(views).toHaveLength(1)
		expect(views[0]).toMatchObject({ operation: first.operation, state: control.result })
		expect(calls.filter((call) => call.operation === 'admit')).toHaveLength(1)
	} finally {
		await dispose()
	}
})
