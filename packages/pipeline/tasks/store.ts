import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-node'
import { Context, Effect, Layer, PubSub, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import type { Worker } from '../worker/schema'
import { type CommandEvent, StoredCommand } from './command'
import { transition } from './machine'
import { type Assignment, CommandNotFound, Task, TaskConflict, TaskNotFound } from './schema'

class StorageDefect extends Schema.TaggedError<StorageDefect>()('StorageDefect', {
	operation: Schema.String,
}) {}
const storage =
	(operation: string) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.catch(() => Effect.die(StorageDefect.make({ operation }))))

const migrations = SqliteMigrator.layer({
	loader: SqliteMigrator.fromRecord({
		'0001_dispatch': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			yield* sql`CREATE TABLE dispatch_tasks (
				id TEXT PRIMARY KEY,
				created_at INTEGER NOT NULL,
				submissions TEXT NOT NULL CHECK(submissions IN ('Open','Closed')),
				worker_id TEXT,
				record TEXT NOT NULL
			)`
			yield* sql`CREATE TABLE dispatch_commands (
				id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL REFERENCES dispatch_tasks(id),
				after_command_id TEXT,
				position INTEGER NOT NULL CHECK(position > 0),
				version INTEGER NOT NULL,
				kind TEXT NOT NULL CHECK(kind IN ('review','resume','interrupt')),
				delivery TEXT NOT NULL CHECK(delivery IN ('Pending','Unconfirmed','Acknowledged','CancelledBeforeSend','Rejected')),
				request_hash TEXT NOT NULL,
				record TEXT NOT NULL,
				UNIQUE(task_id,id),
				UNIQUE(task_id,position),
				FOREIGN KEY(task_id,after_command_id) REFERENCES dispatch_commands(task_id,id)
			)`
			yield* sql`CREATE UNIQUE INDEX dispatch_initial_command ON dispatch_commands(task_id) WHERE kind = 'review'`
			yield* sql`CREATE TABLE dispatch_keys (
				key TEXT PRIMARY KEY,
				request_hash TEXT NOT NULL,
				task_id TEXT NOT NULL,
				command_id TEXT NOT NULL,
				FOREIGN KEY(task_id,command_id) REFERENCES dispatch_commands(task_id,id)
			)`
			yield* sql`CREATE TABLE dispatch_leases (
				worker_id TEXT NOT NULL,
				slot INTEGER NOT NULL CHECK(slot >= 0),
				task_id TEXT NOT NULL UNIQUE REFERENCES dispatch_tasks(id),
				PRIMARY KEY(worker_id,slot)
			)`
		}),
	}),
})
const decodeTask = Schema.decodeUnknownEffect(Schema.fromJsonString(Task))
const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredCommand))

const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	yield* sql`PRAGMA foreign_keys = ON`.pipe(storage('foreignKeys'))
	const updates = yield* PubSub.unbounded<string>()
	const changes = yield* PubSub.sliding<void>(1)
	const transaction =
		(operation: string) =>
		<A, E, R>(effect: Effect.Effect<A, E, R>) =>
			sql
				.withTransaction(effect)
				.pipe(Effect.catchTag('SqlError', () => Effect.die(StorageDefect.make({ operation }))))

	const notify = Effect.fn('TaskStore.notify')(function* (taskId: string, wake: boolean) {
		yield* PubSub.publish(updates, taskId)
		if (wake) yield* PubSub.publish(changes, undefined)
	})

	const getTask = Effect.fn('TaskStore.getTask')(function* (id: string) {
		const rows = yield* sql<{
			record: string
		}>`SELECT record FROM dispatch_tasks WHERE id = ${id}`.pipe(storage('getTask'))
		if (rows[0] === undefined) return yield* TaskNotFound.make({ id })
		return yield* decodeTask(rows[0].record).pipe(storage('decodeTask'))
	})

	const getCommand = Effect.fn('TaskStore.getCommand')(function* (
		taskId: string,
		commandId: string,
	) {
		const rows = yield* sql<{
			task_record: string
			command_record: string | null
		}>`SELECT task.record AS task_record, command.record AS command_record
			FROM dispatch_tasks AS task LEFT JOIN dispatch_commands AS command
			ON command.task_id = task.id AND command.id = ${commandId} WHERE task.id = ${taskId}`.pipe(
			storage('getCommand'),
		)
		const row = rows[0]
		if (row === undefined) return yield* TaskNotFound.make({ id: taskId })
		if (row.command_record === null) return yield* CommandNotFound.make({ taskId, commandId })
		return {
			task: yield* decodeTask(row.task_record).pipe(storage('decodeTask')),
			command: yield* decodeCommand(row.command_record).pipe(storage('decodeCommand')),
		}
	})

	const get = Effect.fn('TaskStore.get')(function* (taskId: string) {
		const task = yield* getTask(taskId)
		const rows = yield* sql<{
			record: string
		}>`SELECT record FROM dispatch_commands WHERE task_id = ${taskId} ORDER BY position`.pipe(
			storage('commands'),
		)
		const commands = yield* Effect.forEach(rows, (row) =>
			decodeCommand(row.record).pipe(storage('decodeCommand')),
		)
		return { task, commands }
	}, transaction('get'))

	const findKey = Effect.fn('TaskStore.findKey')(function* (key: string, requestHash: string) {
		const rows = yield* sql<{
			request_hash: string
			task_id: string
			command_id: string
		}>`SELECT request_hash,task_id,command_id FROM dispatch_keys WHERE key = ${key}`.pipe(
			storage('findKey'),
		)
		const row = rows[0]
		if (row === undefined) return undefined
		if (row.request_hash !== requestHash)
			return yield* TaskConflict.make({ code: 'idempotency_conflict' })
		return yield* getCommand(row.task_id, row.command_id)
	})

	const hasUnconfirmed = Effect.fn('TaskStore.hasUnconfirmed')(function* (taskId: string) {
		const rows =
			yield* sql`SELECT id FROM dispatch_commands WHERE task_id = ${taskId} AND delivery = 'Unconfirmed' LIMIT 1`.pipe(
				storage('unconfirmed'),
			)
		return rows.length > 0
	})
	const hasCapacity = Effect.fn('TaskStore.hasCapacity')(function* (worker: Worker) {
		const rows = yield* sql<{
			count: number
		}>`SELECT count(*) AS count FROM dispatch_leases WHERE worker_id = ${worker.id}`.pipe(
			storage('capacity'),
		)
		return (rows[0]?.count ?? worker.capacity) < worker.capacity
	})

	const writeTask = Effect.fn('TaskStore.writeTask')(function* (task: Task) {
		yield* sql`UPDATE dispatch_tasks SET submissions = ${task.submissions._tag},worker_id = ${task.placement._tag === 'Assigned' ? task.placement.assignment.workerId : null},record = ${JSON.stringify(task)} WHERE id = ${task.id}`.pipe(
			storage('writeTask'),
		)
	})

	const writeCommand = Effect.fn('TaskStore.writeCommand')(function* (command: StoredCommand) {
		yield* sql`UPDATE dispatch_commands SET version = ${command.version},delivery = ${command.delivery._tag},record = ${JSON.stringify(command)} WHERE id = ${command.id}`.pipe(
			storage('writeCommand'),
		)
	})

	const insertCommand = Effect.fn('TaskStore.insertCommand')(function* (
		command: StoredCommand,
		key: string,
	) {
		yield* sql`INSERT INTO dispatch_commands (id,task_id,after_command_id,position,version,kind,delivery,request_hash,record)
			SELECT ${command.id},${command.taskId},${command.afterCommandId ?? null},COALESCE(MAX(position),0)+1,${command.version},${command.kind},${command.delivery._tag},${command.requestHash},${JSON.stringify(command)}
			FROM dispatch_commands WHERE task_id = ${command.taskId}`.pipe(storage('insertCommand'))
		yield* sql`INSERT INTO dispatch_keys (key,request_hash,task_id,command_id) VALUES (${key},${command.requestHash},${command.taskId},${command.id})`.pipe(
			storage('insertKey'),
		)
	})

	const insertTask = Effect.fn('TaskStore.insertTask')(function* (
		task: Task,
		command: StoredCommand,
		key: string,
	) {
		const existing = yield* findKey(key, command.requestHash)
		if (existing !== undefined) return existing

		yield* sql`INSERT INTO dispatch_tasks (id,created_at,submissions,worker_id,record) VALUES (${task.id},${task.createdAt},${task.submissions._tag},NULL,${JSON.stringify(task)})`.pipe(
			storage('insertTask'),
		)
		yield* insertCommand(command, key)
		return { task, command }
	}, transaction('insert'))

	const insert = Effect.fn('TaskStore.insert')(function* (
		task: Task,
		command: StoredCommand,
		key: string,
	) {
		const stored = yield* insertTask(task, command, key)
		yield* notify(stored.task.id, true)
		return stored
	}, Effect.uninterruptible)

	const appendCommand = Effect.fn('TaskStore.appendCommand')(function* (
		taskId: string,
		command: StoredCommand,
		key: string,
	) {
		const existing = yield* findKey(key, command.requestHash)
		if (existing !== undefined) return existing

		const anchor = yield* getCommand(taskId, command.afterCommandId ?? '')
		if (command.kind !== 'interrupt' && anchor.task.submissions._tag === 'Closed')
			return yield* TaskConflict.make({ code: 'task_closed' })
		if (yield* hasUnconfirmed(taskId))
			return yield* TaskConflict.make({ code: 'delivery_unconfirmed' })
		yield* insertCommand(command, key)
		return { task: anchor.task, command }
	}, transaction('append'))

	const append = Effect.fn('TaskStore.append')(function* (
		taskId: string,
		command: StoredCommand,
		key: string,
	) {
		const stored = yield* appendCommand(taskId, command, key)
		yield* notify(stored.task.id, true)
		return stored
	}, Effect.uninterruptible)

	const applyEvent = Effect.fn('TaskStore.applyEvent')(function* (
		taskId: string,
		commandId: string,
		version: number,
		event: CommandEvent,
	) {
		const current = yield* getCommand(taskId, commandId)
		if (current.command.version !== version)
			return yield* TaskConflict.make({ code: 'version_conflict' })
		if (
			event._tag === 'Acknowledged' &&
			(current.task.placement._tag !== 'Assigned' ||
				current.task.placement.assignment.sessionId !== event.nativeRef.sessionId)
		)
			return yield* TaskConflict.make({ code: 'placement_conflict' })

		const command = yield* transition(current.command, event).pipe(Effect.orDie)
		yield* writeCommand(command)
		return { task: current.task, command }
	}, transaction('apply'))

	const apply = Effect.fn('TaskStore.apply')(function* (
		taskId: string,
		commandId: string,
		version: number,
		event: CommandEvent,
	) {
		const stored = yield* applyEvent(taskId, commandId, version, event)
		yield* notify(taskId, false)
		return stored
	}, Effect.uninterruptible)

	const reserveSlot = Effect.fn('TaskStore.reserveSlot')(function* (
		taskId: string,
		worker: Worker,
	) {
		const held = yield* sql`SELECT task_id FROM dispatch_leases WHERE task_id = ${taskId}`.pipe(
			storage('lease'),
		)
		if (held.length > 0) return

		const rows = yield* sql<{
			slot: number
		}>`SELECT slot FROM dispatch_leases WHERE worker_id = ${worker.id}`.pipe(storage('slots'))
		const occupied = new Set(rows.map((row) => row.slot))
		const slot = Array.from({ length: worker.capacity }, (_, index) => index).find(
			(index) => !occupied.has(index),
		)
		if (slot === undefined) return yield* TaskConflict.make({ code: 'capacity_conflict' })
		yield* sql`INSERT INTO dispatch_leases (worker_id,slot,task_id) VALUES (${worker.id},${slot},${taskId})`.pipe(
			storage('reserveSlot'),
		)
	})

	const claimPlacement = Effect.fn('TaskStore.claimPlacement')(function* (
		taskId: string,
		commandId: string,
		version: number,
		worker: Worker,
		assignment: Assignment,
	) {
		const current = yield* getCommand(taskId, commandId)
		if (current.command.version !== version || current.command.delivery._tag !== 'Pending')
			return yield* TaskConflict.make({ code: 'version_conflict' })
		if (
			assignment.workerId !== worker.id ||
			(current.task.placement._tag === 'Assigned' &&
				JSON.stringify(current.task.placement.assignment) !== JSON.stringify(assignment))
		)
			return yield* TaskConflict.make({ code: 'placement_conflict' })
		if (yield* hasUnconfirmed(taskId))
			return yield* TaskConflict.make({ code: 'delivery_unconfirmed' })

		yield* reserveSlot(taskId, worker)
		const task: Task = { ...current.task, placement: { _tag: 'Assigned', assignment } }
		yield* writeTask(task)
		return { task, command: current.command }
	}, transaction('claim'))

	const claim = Effect.fn('TaskStore.claim')(function* (
		taskId: string,
		commandId: string,
		version: number,
		worker: Worker,
		assignment: Assignment,
	) {
		const stored = yield* claimPlacement(taskId, commandId, version, worker, assignment)
		yield* notify(taskId, false)
		return stored
	}, Effect.uninterruptible)

	const closeSubmissions = Effect.fn('TaskStore.closeSubmissions')(function* (taskId: string) {
		const current = yield* get(taskId)
		const task: Task = { ...current.task, submissions: { _tag: 'Closed' } }
		yield* writeTask(task)
		for (const command of current.commands) {
			if (command.delivery._tag !== 'Pending' || command.kind === 'interrupt') continue
			const cancelled = yield* transition(command, { _tag: 'CancelledBeforeSend' }).pipe(
				Effect.orDie,
			)
			yield* writeCommand(cancelled)
		}
		return task
	}, transaction('close'))

	const close = Effect.fn('TaskStore.close')(function* (taskId: string) {
		const task = yield* closeSubmissions(taskId)
		yield* notify(taskId, true)
		return task
	}, Effect.uninterruptible)

	const releaseLease = Effect.fn('TaskStore.releaseLease')(function* (taskId: string) {
		const outstanding =
			yield* sql`SELECT id FROM dispatch_commands WHERE task_id = ${taskId} AND delivery IN ('Pending','Unconfirmed') LIMIT 1`.pipe(
				storage('outstanding'),
			)
		if (outstanding.length > 0) return false
		const released =
			yield* sql`DELETE FROM dispatch_leases WHERE task_id = ${taskId} RETURNING task_id`.pipe(
				storage('release'),
			)
		return released.length > 0
	}, transaction('release'))

	const release = Effect.fn('TaskStore.release')(function* (taskId: string) {
		if (yield* releaseLease(taskId)) yield* notify(taskId, true)
	}, Effect.uninterruptible)

	const hasLease = Effect.fn('TaskStore.hasLease')(function* (taskId: string) {
		const rows = yield* sql`SELECT task_id FROM dispatch_leases WHERE task_id = ${taskId}`.pipe(
			storage('hasLease'),
		)
		return rows.length > 0
	})

	const work = Effect.fn('TaskStore.work')(function* () {
		const rows = yield* sql<{ id: string }>`SELECT id FROM dispatch_tasks
			WHERE id IN (SELECT task_id FROM dispatch_commands WHERE delivery IN ('Pending','Unconfirmed'))
				OR id IN (SELECT task_id FROM dispatch_leases)
			ORDER BY created_at,id`.pipe(storage('work'))
		return rows.map((row) => row.id)
	})

	const notifyWorker = Effect.fn('TaskStore.notifyWorker')(function* (workerId: string) {
		const rows = yield* sql<{
			id: string
		}>`SELECT id FROM dispatch_tasks WHERE worker_id = ${workerId}`.pipe(storage('notifyWorker'))
		yield* Effect.forEach(rows, (row) => notify(row.id, false), { discard: true })
	})

	return {
		get,
		getTask,
		getCommand,
		findKey,
		insert,
		append,
		apply,
		claim,
		close,
		release,
		hasLease,
		hasCapacity,
		work,
		notifyWorker,
		subscribeUpdates: PubSub.subscribe(updates),
		subscribeChanges: PubSub.subscribe(changes),
	}
})

/** Mutations commit before notifying; subscribe before reading to observe every later commit. Changes signal new commands, closes, and released capacity. */
export class TaskStore extends Context.Service<TaskStore, Effect.Success<typeof make>>()(
	'pipeline/tasks/TaskStore',
) {}
export const taskStoreLayer = (filename: string) =>
	Layer.effect(TaskStore, make).pipe(
		Layer.provide(migrations.pipe(Layer.provideMerge(SqliteClient.layer({ filename })))),
	)
