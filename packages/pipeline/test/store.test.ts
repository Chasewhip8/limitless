import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Scheduler } from '../scheduler'
import { Tasks } from '../tasks/service'
import { TaskStore } from '../tasks/store'
import { coordinator, review } from './fixtures'

let directory = ''
beforeEach(async () => {
	directory = await mkdtemp('/tmp/opencode/pipeline-store-')
})
afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})

const raw = <A extends object>(filename: string, query: string) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			return yield* sql.unsafe<A>(query)
		}).pipe(Effect.provide(SqliteClient.layer({ filename }))),
	)

test('storage holds only routing, outbox, receipts and reservations, and drops payloads on acknowledgment', async () => {
	const database = path.join(directory, 'pipeline.sqlite')
	const { runtime } = coordinator({}, database)
	const { command } = await runtime.runPromise(
		Effect.gen(function* () {
			const tasks = yield* Tasks
			const submitted = yield* tasks.submit('review', review())
			yield* (yield* Scheduler).tick()
			return submitted
		}),
	)
	await runtime.dispose()

	const tables = await raw<{ name: string }>(
		database,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'effect_%' ORDER BY name",
	)
	expect(tables.map((table) => table.name)).toEqual([
		'dispatch_commands',
		'dispatch_keys',
		'dispatch_leases',
		'dispatch_tasks',
	])
	const [row] = await raw<{ delivery: string; record: string }>(
		database,
		`SELECT delivery, record FROM dispatch_commands WHERE id = '${command.id}'`,
	)
	expect(row?.delivery).toBe('Acknowledged')
	expect(row?.record).not.toContain('Review https://github.com')
	expect(row?.record).toContain(command.requestHash)
	expect(row?.record).toContain(`"messageId":"${command.messageId}"`)
})

test('an unconfirmed delivery survives restart with its exact payload and is never resent or downgraded', async () => {
	const database = path.join(directory, 'pipeline.sqlite')
	const first = coordinator({}, database)
	first.control.dropAdmit = true
	const submitted = await first.runtime.runPromise(
		Effect.gen(function* () {
			const submitted = yield* (yield* Tasks).submit('review', review())
			yield* (yield* Scheduler).tick()
			return submitted
		}),
	)
	await first.runtime.dispose()

	const second = coordinator({}, database)
	second.control.observation = { _tag: 'Idle' }
	const view = await second.runtime.runPromise(
		Effect.gen(function* () {
			const scheduler = yield* Scheduler
			yield* scheduler.tick()
			yield* scheduler.tick()
			return yield* (yield* Tasks).getCommand(submitted.task.id, submitted.command.id)
		}),
	)
	await second.runtime.dispose()

	expect(view.command.delivery).toEqual({ _tag: 'Unconfirmed' })
	expect(first.calls.filter((call) => call.operation === 'admit')).toHaveLength(1)
	expect(second.calls.some((call) => call.operation === 'admit')).toBe(false)
	expect(second.calls.filter((call) => call.operation === 'findAdmission')).toHaveLength(2)
	const [row] = await raw<{ record: string }>(
		database,
		`SELECT record FROM dispatch_commands WHERE id = '${submitted.command.id}'`,
	)
	expect(row?.record).toContain('Review https://github.com/test/repo/pull/1')
})

test('idempotency keys recover the same receipt and refuse a different intent', async () => {
	const { runtime } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const [a, b] = yield* Effect.all(
					[tasks.submit('key', review()), tasks.submit('key', review())],
					{ concurrency: 2 },
				)
				expect(b).toEqual(a)
				const conflict = yield* tasks.submit('key', review(2)).pipe(Effect.flip)
				expect(conflict).toMatchObject({ _tag: 'TaskConflict', code: 'idempotency_conflict' })

				const resume = { afterCommandId: a.command.id, message: 'Again.' }
				const first = yield* tasks.resume(a.task.id, 'resume', resume)
				const again = yield* tasks.resume(a.task.id, 'resume', resume)
				expect(again.command.id).toBe(first.command.id)
				const changed = yield* tasks
					.resume(a.task.id, 'resume', { ...resume, message: 'Different.' })
					.pipe(Effect.flip)
				expect(changed).toMatchObject({ code: 'idempotency_conflict' })
				const { commands } = yield* (yield* TaskStore).get(a.task.id)
				expect(commands).toHaveLength(2)
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test('an unconfirmed delivery blocks every followup until positive acknowledgment', async () => {
	const { runtime, control } = coordinator()
	control.loseAdmitReply = true
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const scheduler = yield* Scheduler
				const { task, command } = yield* tasks.submit('review', review())
				control.historyUnavailable = true
				yield* scheduler.tick()
				expect((yield* tasks.getCommand(task.id, command.id)).command.delivery._tag).toBe(
					'Unconfirmed',
				)
				for (const followup of [
					tasks.resume(task.id, 'resume', { afterCommandId: command.id, message: 'More.' }),
					tasks.interrupt(task.id, 'interrupt', { afterCommandId: command.id }),
				]) {
					expect(yield* followup.pipe(Effect.flip)).toMatchObject({ code: 'delivery_unconfirmed' })
				}

				control.historyUnavailable = false
				yield* scheduler.tick()
				expect((yield* tasks.getCommand(task.id, command.id)).command.delivery._tag).toBe(
					'Acknowledged',
				)
				const resumed = yield* tasks.resume(task.id, 'resume', {
					afterCommandId: command.id,
					message: 'More.',
				})
				expect(resumed.command.delivery).toEqual({ _tag: 'Pending', step: 'session' })
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test('followup anchors must belong to the addressed task', async () => {
	const { runtime } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const first = yield* tasks.submit('first', review(1))
				const second = yield* tasks.submit('second', review(2))
				const error = yield* tasks
					.resume(second.task.id, 'resume', { afterCommandId: first.command.id, message: 'x' })
					.pipe(Effect.flip)
				expect(error._tag).toBe('CommandNotFound')
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test('close is logical: it cancels only unsent messages, keeps possible deliveries, and still accepts interrupts', async () => {
	const { runtime, calls } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const scheduler = yield* Scheduler
				const { task, command } = yield* tasks.submit('review', review())
				yield* scheduler.tick()
				const queued = yield* tasks.resume(task.id, 'resume', {
					afterCommandId: command.id,
					message: 'Queued.',
				})
				const closed = yield* tasks.close(task.id)
				expect(closed.submissions._tag).toBe('Closed')
				expect(yield* tasks.close(task.id)).toEqual(closed)

				const view = yield* tasks.get(task.id)
				expect(view.commands.map((command) => command.delivery._tag)).toEqual([
					'Acknowledged',
					'CancelledBeforeSend',
				])
				const refused = yield* tasks
					.resume(task.id, 'late', { afterCommandId: command.id, message: 'Late.' })
					.pipe(Effect.flip)
				expect(refused).toMatchObject({ code: 'task_closed' })

				const interrupt = yield* tasks.interrupt(task.id, 'stop', {
					afterCommandId: queued.command.id,
				})
				yield* scheduler.tick()
				const stopped = yield* tasks.getCommand(task.id, interrupt.command.id)
				expect(stopped.command.delivery._tag).toBe('Acknowledged')
				expect(stopped.task.placement).toEqual(view.task.placement)
			}),
		)
		expect(calls.filter((call) => call.operation === 'interrupt')).toHaveLength(1)
		expect(calls.filter((call) => call.operation === 'admit')).toHaveLength(1)
	} finally {
		await runtime.dispose()
	}
})
