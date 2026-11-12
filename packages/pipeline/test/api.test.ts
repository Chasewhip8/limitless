import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { NodeServices } from '@effect/platform-node'
import { Effect, Layer, Schema } from 'effect'
import { HttpRouter, HttpServer } from 'effect/http'
import { expect, test } from 'vitest'
import { PipelineConfig } from '../config'
import { Scheduler } from '../scheduler'
import { routesLayer } from '../server'
import { CommandView, DispatchReceipt, Task, TaskView } from '../tasks/schema'
import { Tasks } from '../tasks/service'
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
	const request = (url: string, method = 'GET', body?: unknown, key?: string) =>
		handler(
			new Request(`http://localhost${url}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
					...(key === undefined ? {} : { 'idempotency-key': key }),
				},
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

const decode =
	<S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
	async (response: Response): Promise<S['Type']> => {
		const body = await response.json()
		expect(JSON.stringify(body)).not.toMatch(/runId|afterRunId|"result"/)
		return Schema.decodeUnknownSync(schema)(body)
	}
const receipt = decode(DispatchReceipt)

test('every route requires auth and dispatch routes return durable idempotent receipts', async () => {
	const { handler, request, tick, dispose } = await harness()
	try {
		const id = '11111111-1111-4111-8111-000000000001'
		for (const [url, method] of [
			['/health', 'GET'],
			['/tasks', 'POST'],
			[`/tasks/${id}`, 'GET'],
			[`/tasks/${id}/resume`, 'POST'],
			[`/tasks/${id}/interrupt`, 'POST'],
			[`/tasks/${id}/close`, 'POST'],
			[`/tasks/${id}/commands/${id}`, 'GET'],
			[`/tasks/${id}/commands/${id}/events`, 'GET'],
		] as const) {
			expect((await handler(new Request(`http://localhost${url}`, { method }))).status).toBe(401)
		}
		expect((await request('/tasks', 'POST', review())).status).toBe(400)

		const responses = await Promise.all([
			request('/tasks', 'POST', review(), 'first'),
			request('/tasks', 'POST', review(), 'first'),
		])
		expect(responses.map((response) => response.status)).toEqual([202, 202])
		const [first, duplicate] = await Promise.all(responses.map(receipt))
		expect(duplicate).toEqual(first)
		if (first === undefined) throw new Error('Missing submission')
		expect(
			(await request('/tasks', 'POST', { ...review(), system: 'aarch64-linux' }, 'first')).status,
		).toBe(409)

		const base = `/tasks/${first.task.id}`
		await tick()
		const resumeBody = { afterCommandId: first.command.id, message: 'Continue.' }
		const resumed = await receipt(await request(`${base}/resume`, 'POST', resumeBody, 'next'))
		const again = await receipt(await request(`${base}/resume`, 'POST', resumeBody, 'next'))
		expect(again.command.id).toBe(resumed.command.id)
		expect(resumed.command).toMatchObject({
			kind: 'resume',
			afterCommandId: first.command.id,
			delivery: { _tag: 'Pending', step: 'send' },
		})

		const closed = await decode(Task)(await request(`${base}/close`, 'POST'))
		expect(closed.submissions._tag).toBe('Closed')
		expect((await request(`${base}/resume`, 'POST', resumeBody, 'late')).status).toBe(409)
		const interrupt = await request(
			`${base}/interrupt`,
			'POST',
			{ afterCommandId: first.command.id },
			'stop',
		)
		expect(interrupt.status).toBe(202)

		const view = await decode(TaskView)(await request(base))
		expect(view.commands.map((command) => [command.kind, command.delivery._tag])).toEqual([
			['review', 'Acknowledged'],
			['resume', 'CancelledBeforeSend'],
			['interrupt', 'Pending'],
		])
		const command = await decode(CommandView)(await request(`${base}/commands/${first.command.id}`))
		expect(command.observation._tag).toBe('Running')
		expect((await request(`${base}/commands/${id}`)).status).toBe(404)
		expect(
			(await request(`/tasks/${id}/resume`, 'POST', { ...resumeBody, afterCommandId: id }, 'x'))
				.status,
		).toBe(404)
	} finally {
		await dispose()
	}
})

test('command events stream NDJSON views until the acknowledged command is observed idle', async () => {
	const { request, tick, control, dispose } = await harness()
	try {
		const first = await receipt(await request('/tasks', 'POST', review(), 'first'))
		const url = `/tasks/${first.task.id}/commands/${first.command.id}/events`
		const response = await request(url)
		expect(response.headers.get('content-type')).toContain('application/x-ndjson')
		const reader = response.body?.getReader()
		if (reader === undefined) throw new Error('Missing event stream')
		const decoder = new TextDecoder()
		let text = decoder.decode((await reader.read()).value, { stream: true })
		await tick()
		control.observation = { _tag: 'Idle' }
		await tick()
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
			text += decoder.decode(chunk.value, { stream: true })
		const views = text
			.split('\n')
			.filter((line) => line !== '')
			.map((line) => Schema.decodeUnknownSync(CommandView)(JSON.parse(line)))
		expect(views[0]?.command.delivery._tag).toBe('Pending')
		expect(views.at(-1)).toMatchObject({
			command: { delivery: { _tag: 'Acknowledged' } },
			observation: { _tag: 'Idle' },
		})

		const reconnect = (await (await request(url)).text()).trim().split('\n')
		expect(reconnect).toHaveLength(1)
	} finally {
		await dispose()
	}
})
