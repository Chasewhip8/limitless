import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-node'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type CommandEvent, StoredCommand } from '../tasks/command'
import { type Assignment, type PullRequest, Task } from '../tasks/schema'
import { TaskStore, taskStoreLayer } from '../tasks/store'
import type { Worker } from '../worker/schema'
import { pullRequestSource } from '../worker/source'

let directory = ''
beforeEach(async () => {
	directory = await mkdtemp('/tmp/opencode/pipeline-store-')
})
afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})

const pullRequest: PullRequest = {
	url: 'https://github.com/test/repo/pull/1',
	repository: 'test/repo',
	sourceRepository: 'test/repo',
	repositoryId: 7,
	sourceRepositoryId: 7,
	number: 1,
	headRef: 'feature',
	headSha: 'a'.repeat(40),
	baseSha: 'b'.repeat(40),
}
const source = Effect.runSync(pullRequestSource(pullRequest))
const worker: Worker = {
	id: 'pc',
	url: 'https://pc.example.test',
	credentialFile: '/tmp/opencode/test-password',
	controlDirectory: '/tmp/opencode/pipeline-test-control',
	system: 'x86_64-linux',
	capacity: 4,
	openCodeVersion: '2.2.7',
}
const key = '7:1'
type Stored = { task: Task; command: StoredCommand }
type Attempt = Effect.Effect<unknown, unknown, TaskStore>

const newTask = (reviewKey = key) =>
	Task.make({
		id: randomUUID(),
		createdAt: 0,
		request: { pr: pullRequest.url },
		reviewKey,
		submissions: { _tag: 'Open' },
		placement: { _tag: 'Unassigned' },
	})

const command = (
	taskId: string,
	payload: 'Review' | 'Resume' | 'Interrupt',
	afterCommandId?: string,
) => {
	const id = randomUUID()
	const base = { id, taskId, createdAt: 0, version: 0 }
	const anchor = afterCommandId === undefined ? {} : { afterCommandId }
	const messageId = `msg_pipeline${id.replaceAll('-', '')}`
	switch (payload) {
		case 'Review':
			return StoredCommand.make({
				...base,
				kind: 'review',
				messageId,
				delivery: {
					_tag: 'Pending',
					step: 'session',
					payload: { _tag: 'Review', pr: pullRequest, source, prompt: 'Review once.' },
				},
			})
		case 'Resume':
			return StoredCommand.make({
				...base,
				...anchor,
				kind: 'resume',
				messageId,
				delivery: {
					_tag: 'Pending',
					step: 'send',
					payload: { _tag: 'Resume', prompt: 'Continue.' },
				},
			})
		case 'Interrupt':
			return StoredCommand.make({
				...base,
				...anchor,
				kind: 'interrupt',
				delivery: { _tag: 'Pending', step: 'send', payload: { _tag: 'Interrupt' } },
			})
	}
}

const assignment = (taskId: string): Assignment => ({
	workerId: worker.id,
	workerUrl: worker.url,
	controlDirectory: worker.controlDirectory,
	storageId: 'storage-pc',
	workspaceId: `wrk_${taskId}`,
	sessionId: `ses_${taskId}`,
	directory: `/tmp/opencode/pipeline-test-checkouts/${taskId}`,
})

const review = Effect.fn('test.review')(function* (reviewKey = key) {
	const task = newTask(reviewKey)
	return yield* (yield* TaskStore).insert(task, command(task.id, 'Review'))
})
const resume = Effect.fn('test.resume')(function* (after: Stored) {
	return yield* (yield* TaskStore).append(command(after.task.id, 'Resume', after.command.id))
})
const interrupt = Effect.fn('test.interrupt')(function* (after: Stored) {
	return yield* (yield* TaskStore).append(command(after.task.id, 'Interrupt', after.command.id))
})
const restart = Effect.fn('test.restart')(function* (after: Stored) {
	const task = newTask(after.task.reviewKey)
	return yield* (yield* TaskStore).restart(after.command.id, task, command(task.id, 'Review'))
})

const advance = Effect.fn('test.advance')(function* (stored: Stored, event: CommandEvent) {
	const store = yield* TaskStore
	const { command } = yield* store.getCommand(stored.task.id, stored.command.id)
	return yield* store.apply(stored.task.id, stored.command.id, command.version, event)
})

/** Drives the scheduler's durable steps: placement, preparation, write-ahead Unconfirmed, acknowledgment. */
const deliver = Effect.fn('test.deliver')(function* (
	stored: Stored,
	until: 'Unconfirmed' | 'Acknowledged' = 'Acknowledged',
) {
	const store = yield* TaskStore
	const { task, command } = yield* store.getCommand(stored.task.id, stored.command.id)
	const placement = assignment(task.id)
	yield* store.claim(task.id, command.id, command.version, worker, placement)
	if (command.kind === 'review') yield* advance(stored, { _tag: 'SessionPrepared' })
	const started = yield* advance(stored, { _tag: 'DeliveryStarted' })
	if (until === 'Unconfirmed') return started
	const messageId = started.command.messageId
	return yield* advance(stored, {
		_tag: 'Acknowledged',
		nativeRef: {
			sessionId: placement.sessionId,
			...(messageId === undefined ? {} : { messageId }),
		},
	})
})

const run = <A, E>(effect: Effect.Effect<A, E, TaskStore>, database = ':memory:') =>
	Effect.runPromise(effect.pipe(Effect.provide(taskStoreLayer(database))))

const raw = <A extends object>(filename: string, query: string) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			return yield* sql.unsafe<A>(query)
		}).pipe(Effect.provide(SqliteClient.layer({ filename }))),
	)

/** The released 0001 schema, frozen as written by deployments before migration 0002. */
const releasedSchema = [
	`CREATE TABLE dispatch_tasks (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, submissions TEXT NOT NULL CHECK(submissions IN ('Open','Closed')), worker_id TEXT, record TEXT NOT NULL)`,
	`CREATE TABLE dispatch_commands (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES dispatch_tasks(id), after_command_id TEXT, position INTEGER NOT NULL CHECK(position > 0), version INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('review','resume','interrupt')), delivery TEXT NOT NULL CHECK(delivery IN ('Pending','Unconfirmed','Acknowledged','CancelledBeforeSend','Rejected')), request_hash TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(task_id,id), UNIQUE(task_id,position), FOREIGN KEY(task_id,after_command_id) REFERENCES dispatch_commands(task_id,id))`,
	`CREATE UNIQUE INDEX dispatch_initial_command ON dispatch_commands(task_id) WHERE kind = 'review'`,
	`CREATE TABLE dispatch_keys (key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, task_id TEXT NOT NULL, command_id TEXT NOT NULL, FOREIGN KEY(task_id,command_id) REFERENCES dispatch_commands(task_id,id))`,
	`CREATE TABLE dispatch_leases (worker_id TEXT NOT NULL, slot INTEGER NOT NULL CHECK(slot >= 0), task_id TEXT NOT NULL UNIQUE REFERENCES dispatch_tasks(id), PRIMARY KEY(worker_id,slot))`,
]

const releasedDatabase = (filename: string, rows: ReadonlyArray<string>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			for (const row of rows) yield* sql.unsafe(row)
		}).pipe(
			Effect.provide(
				SqliteMigrator.layer({
					loader: SqliteMigrator.fromRecord({
						'0001_dispatch': Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient
							for (const statement of releasedSchema) yield* sql.unsafe(statement)
						}),
					}),
				}).pipe(Layer.provideMerge(SqliteClient.layer({ filename }))),
			),
		),
	)

const snapshot = async (filename: string) => ({
	schema: await raw(filename, 'SELECT type, name, sql FROM sqlite_master ORDER BY name'),
	migrations: await raw(filename, 'SELECT migration_id, name FROM effect_sql_migrations'),
	rows: await Promise.all(
		['dispatch_tasks', 'dispatch_commands', 'dispatch_keys', 'dispatch_leases'].map((table) =>
			raw(filename, `SELECT * FROM ${table} ORDER BY rowid`),
		),
	),
})

test('a populated released database refuses startup with a diagnostic and stays unchanged', async () => {
	const database = path.join(directory, 'pipeline.sqlite')
	const task = '11111111-1111-4111-8111-000000000001'
	await releasedDatabase(database, [
		`INSERT INTO dispatch_tasks VALUES ('${task}', 0, 'Open', 'pc', '{}')`,
		`INSERT INTO dispatch_commands VALUES ('22222222-2222-4222-8222-000000000001', '${task}', NULL, 1, 3, 'review', 'Acknowledged', 'hash-a', '{}')`,
		`INSERT INTO dispatch_commands VALUES ('22222222-2222-4222-8222-000000000002', '${task}', '22222222-2222-4222-8222-000000000001', 2, 1, 'resume', 'Unconfirmed', 'hash-b', '{"payload":"exact"}')`,
		`INSERT INTO dispatch_keys VALUES ('caller-key', 'hash-b', '${task}', '22222222-2222-4222-8222-000000000002')`,
		`INSERT INTO dispatch_leases VALUES ('pc', 0, '${task}')`,
	])
	const before = await snapshot(database)

	const error = await Effect.runPromise(
		Effect.provide(Effect.service(TaskStore), taskStoreLayer(database)).pipe(Effect.flip),
	)

	expect(error).toMatchObject({
		_tag: 'MigrationError',
		kind: 'Failed',
		cause: { _tag: 'LegacyStateRefused', tasks: 1, commands: 2, keys: 1, leases: 1 },
	})
	expect(String((error as { cause: { message: string } }).cause.message)).toContain(
		'This database is unchanged; preserve it and use the previous coordinator',
	)
	expect(await snapshot(database)).toEqual(before)
})

test('an empty released database migrates, and mapped work persists across restarts', async () => {
	const database = path.join(directory, 'pipeline.sqlite')
	await releasedDatabase(database, [])
	const first = await run(review(), database)
	const again = await run(
		Effect.gen(function* () {
			const store = yield* TaskStore
			return { current: yield* store.current(key), retry: yield* review() }
		}),
		database,
	)

	expect(again.current).toEqual(first)
	expect(again.retry).toEqual(first)
	expect(await raw(database, 'SELECT migration_id FROM effect_sql_migrations')).toEqual([
		{ migration_id: 1 },
		{ migration_id: 2 },
	])
})

test('storage holds routing, outbox and reservations, and an Unconfirmed payload survives restart until acknowledgment', async () => {
	const database = path.join(directory, 'pipeline.sqlite')
	const stored = await run(
		Effect.gen(function* () {
			const stored = yield* review()
			yield* deliver(stored, 'Unconfirmed')
			return stored
		}),
		database,
	)

	const tables = await raw<{ name: string }>(
		database,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'effect_%' ORDER BY name",
	)
	expect(tables.map((table) => table.name)).toEqual([
		'dispatch_commands',
		'dispatch_leases',
		'dispatch_reviews',
		'dispatch_tasks',
	])
	const unconfirmed = await run(
		Effect.gen(function* () {
			const store = yield* TaskStore
			return yield* store.getOperation(stored.command.id)
		}),
		database,
	)
	expect(unconfirmed.command.delivery).toMatchObject({
		_tag: 'Unconfirmed',
		payload: { _tag: 'Review', prompt: 'Review once.' },
	})

	await run(
		advance(stored, {
			_tag: 'Acknowledged',
			nativeRef: {
				sessionId: assignment(stored.task.id).sessionId,
				...(stored.command.messageId === undefined ? {} : { messageId: stored.command.messageId }),
			},
		}),
		database,
	)
	const [row] = await raw<{ delivery: string; record: string }>(
		database,
		`SELECT delivery, record FROM dispatch_commands WHERE id = '${stored.command.id}'`,
	)
	expect(row?.delivery).toBe('Acknowledged')
	expect(row?.record).not.toContain('Review once.')
})

test('concurrent reviews of one PR create one task and every retry returns its current operation', async () => {
	await run(
		Effect.gen(function* () {
			const store = yield* TaskStore
			const a = newTask()
			const b = newTask()
			const [first, second] = yield* Effect.all(
				[store.insert(a, command(a.id, 'Review')), store.insert(b, command(b.id, 'Review'))],
				{ concurrency: 'unbounded' },
			)
			expect(second).toEqual(first)
			const loser = first.task.id === a.id ? b : a
			expect(yield* store.getTask(loser.id).pipe(Effect.flip)).toMatchObject({
				_tag: 'TaskNotFound',
			})
			expect((yield* review('7:2')).task.id).not.toBe(first.task.id)

			yield* deliver(first)
			const continued = yield* resume(first)
			yield* deliver(continued)
			yield* interrupt(continued)
			const latest = yield* store.getOperation(continued.command.id)
			expect(yield* store.current(key)).toEqual(latest)
			expect(yield* review()).toEqual(latest)
		}),
	)
})

test('an action after an operation is durable across later progress, close and restart', async () => {
	await run(
		Effect.gen(function* () {
			const store = yield* TaskStore
			const initial = yield* review()
			yield* deliver(initial)
			const continued = yield* resume(initial)
			yield* deliver(continued)
			const stop = yield* interrupt(continued)
			expect(yield* interrupt(continued)).toEqual(stop)
			yield* deliver(stop)
			const next = yield* resume(continued)
			yield* deliver(next)
			expect(yield* resume(initial)).toEqual(yield* store.getOperation(continued.command.id))

			const closed = yield* store.close(next.command.id)
			expect(closed.submissions._tag).toBe('Closed')
			const restarted = yield* restart(next)
			expect(restarted.command.afterCommandId).toBe(next.command.id)
			expect(yield* restart(next)).toEqual(restarted)
			expect(yield* store.findAction('restart', next.command.id)).toEqual(restarted)

			const retried = yield* resume(initial)
			expect(retried.command.id).toBe(continued.command.id)
			expect(retried.task.submissions._tag).toBe('Closed')
			expect((yield* interrupt(continued)).command.id).toBe(stop.command.id)
			expect(yield* review()).toEqual(restarted)
			expect(yield* store.current(key)).toEqual(restarted)
		}),
	)
})

test('only the current latest message operation can anchor a followup, close or restart', async () => {
	await run(
		Effect.gen(function* () {
			const store = yield* TaskStore
			const initial = yield* review()
			yield* deliver(initial)
			const continued = yield* resume(initial)
			yield* deliver(continued)
			const stop = yield* interrupt(continued)
			yield* deliver(stop)

			const stale: ReadonlyArray<Attempt> = [
				store.checkAnchor(initial.command.id),
				interrupt(initial),
				restart(initial),
				store.close(initial.command.id),
			]
			for (const attempt of stale)
				expect(yield* attempt.pipe(Effect.flip)).toMatchObject({ code: 'stale_operation' })
			const notOperation: ReadonlyArray<Attempt> = [
				store.checkAnchor(stop.command.id),
				resume(stop),
				store.close(stop.command.id),
				store.checkAnchor(randomUUID()),
			]
			for (const attempt of notOperation)
				expect(yield* attempt.pipe(Effect.flip)).toMatchObject({ _tag: 'OperationNotFound' })

			const successor = yield* restart(continued)
			const predecessor = yield* store.getTask(continued.task.id)
			expect(predecessor.submissions._tag).toBe('Closed')
			expect(predecessor.placement).toEqual({
				_tag: 'Assigned',
				assignment: assignment(continued.task.id),
			})
			expect(yield* store.hasLease(continued.task.id)).toBe(true)
			expect(yield* store.work()).toContain(continued.task.id)
			expect(
				yield* store.checkAnchor(continued.command.id, { allowClosed: true }).pipe(Effect.flip),
			).toMatchObject({ code: 'stale_operation' })
			expect(yield* store.close(initial.command.id)).toEqual(predecessor)
			expect(yield* store.checkAnchor(successor.command.id)).toEqual(successor)
		}),
	)
})

test('continue, close and restart from one operation race to a single winner', async () => {
	await run(
		Effect.gen(function* () {
			const store = yield* TaskStore
			const races: ReadonlyArray<(head: Stored) => ReadonlyArray<Attempt>> = [
				(head: Stored) => [resume(head), restart(head)],
				(head: Stored) => [resume(head), store.close(head.command.id)],
				(head: Stored) => [interrupt(head), restart(head)],
			]
			for (const [index, race] of races.entries()) {
				const head = yield* review(`7:${10 + index}`)
				yield* deliver(head)
				const outcomes = yield* Effect.all(
					race(head).map((attempt) => Effect.result(attempt)),
					{ concurrency: 'unbounded' },
				)
				expect(outcomes.filter((outcome) => outcome._tag === 'Success')).toHaveLength(1)
			}

			const head = yield* review('7:20')
			yield* deliver(head)
			const [a, b] = yield* Effect.all([resume(head), resume(head)], { concurrency: 'unbounded' })
			expect(b).toEqual(a)
			yield* deliver(a)
			const [x, y] = yield* Effect.all([restart(a), restart(a)], { concurrency: 'unbounded' })
			expect(y).toEqual(x)
			expect(yield* store.current(head.task.reviewKey)).toEqual(x)
		}),
	)
})

test('a Pending or Unconfirmed delivery blocks every followup until it settles', async () => {
	await run(
		Effect.gen(function* () {
			const store = yield* TaskStore
			const initial = yield* review()
			expect(yield* store.checkAnchor(initial.command.id)).toEqual(initial)
			const followups = (): ReadonlyArray<Attempt> => [
				resume(initial),
				interrupt(initial),
				restart(initial),
			]
			for (const blocked of followups())
				expect(yield* blocked.pipe(Effect.flip)).toMatchObject({ code: 'operation_pending' })

			yield* deliver(initial, 'Unconfirmed')
			for (const blocked of followups())
				expect(yield* blocked.pipe(Effect.flip)).toMatchObject({ code: 'delivery_unconfirmed' })

			yield* advance(initial, {
				_tag: 'Acknowledged',
				nativeRef: {
					sessionId: assignment(initial.task.id).sessionId,
					...(initial.command.messageId === undefined
						? {}
						: { messageId: initial.command.messageId }),
				},
			})
			yield* interrupt(initial)
			expect(yield* resume(initial).pipe(Effect.flip)).toMatchObject({
				code: 'operation_pending',
			})
		}),
	)
})

test('close cancels only unsent messages, keeps possible deliveries, and still accepts interrupts', async () => {
	await run(
		Effect.gen(function* () {
			const store = yield* TaskStore
			const initial = yield* review()
			yield* deliver(initial)
			const queued = yield* resume(initial)
			const closed = yield* store.close(queued.command.id)
			expect(yield* store.close(queued.command.id)).toEqual(closed)
			expect(yield* store.close(initial.command.id)).toEqual(closed)

			const { commands } = yield* store.get(initial.task.id)
			expect(commands.map((command) => command.delivery._tag)).toEqual([
				'Acknowledged',
				'CancelledBeforeSend',
			])
			expect(yield* store.checkAnchor(queued.command.id).pipe(Effect.flip)).toMatchObject({
				code: 'task_closed',
			})
			const stop = yield* interrupt(queued)
			expect(stop.task.submissions._tag).toBe('Closed')

			const other = yield* review('7:2')
			yield* deliver(other)
			const sending = yield* resume(other)
			yield* deliver(sending, 'Unconfirmed')
			yield* store.close(sending.command.id)
			expect((yield* store.getOperation(sending.command.id)).command.delivery._tag).toBe(
				'Unconfirmed',
			)
		}),
	)
})
