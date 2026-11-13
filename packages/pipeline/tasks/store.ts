import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-node'
import { Context, Effect, Layer, PubSub, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import type { Worker } from '../worker/schema'
import { type CommandEvent, StoredCommand } from './command'
import { transition } from './machine'
import {
	type Assignment,
	CommandNotFound,
	OperationNotFound,
	Task,
	TaskConflict,
	TaskNotFound,
} from './schema'

class StorageDefect extends Schema.TaggedError<StorageDefect>()('StorageDefect', {
	operation: Schema.String,
}) {}
const storage =
	(operation: string) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.catch(() => Effect.die(StorageDefect.make({ operation }))))

class InvalidStoreRequest extends Schema.TaggedError<InvalidStoreRequest>()('InvalidStoreRequest', {
	reason: Schema.Literals(['append_command', 'restart_successor']),
}) {}

export class LegacyStateRefused extends Schema.TaggedError<LegacyStateRefused>()(
	'LegacyStateRefused',
	{
		tasks: Schema.Int,
		commands: Schema.Int,
		keys: Schema.Int,
		leases: Schema.Int,
		message: Schema.String,
	},
	{
		description:
			'Migration 0002 found legacy dispatch state. It never deletes tasks, chooses among duplicate PR tasks, or settles possibly delivered commands; the database is left unchanged.',
	},
) {}

const refuseLegacyState = Effect.fn('TaskStore.refuseLegacyState')(function* () {
	const sql = yield* SqlClient.SqlClient
	const [counts] = yield* sql<{
		tasks: number
		commands: number
		keys: number
		leases: number
	}>`SELECT (SELECT count(*) FROM dispatch_tasks) AS tasks,
		(SELECT count(*) FROM dispatch_commands) AS commands,
		(SELECT count(*) FROM dispatch_keys) AS keys,
		(SELECT count(*) FROM dispatch_leases) AS leases`
	if (counts === undefined) return
	const { tasks, commands, keys, leases } = counts
	if (tasks + commands + keys + leases === 0) return
	return yield* LegacyStateRefused.make({
		...counts,
		message: `Pipeline database holds legacy dispatch state (${tasks} tasks, ${commands} commands, ${keys} idempotency keys, ${leases} leases). Migration 0002 requires an explicit reviewed mapping of retained reviews and pending deliveries before deployment. This database is unchanged; preserve it and use the previous coordinator until that migration is available.`,
	})
})

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
		'0002_operations': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			yield* refuseLegacyState()
			yield* sql`DROP TABLE dispatch_keys`
			yield* sql`DROP TABLE dispatch_leases`
			yield* sql`DROP TABLE dispatch_commands`
			yield* sql`DROP TABLE dispatch_tasks`
			yield* sql`CREATE TABLE dispatch_tasks (
				id TEXT PRIMARY KEY,
				created_at INTEGER NOT NULL,
				review_key TEXT NOT NULL,
				submissions TEXT NOT NULL CHECK(submissions IN ('Open','Closed')),
				worker_id TEXT,
				record TEXT NOT NULL
			)`
			yield* sql`CREATE TABLE dispatch_reviews (
				review_key TEXT PRIMARY KEY,
				task_id TEXT NOT NULL UNIQUE REFERENCES dispatch_tasks(id)
			)`
			yield* sql`CREATE TABLE dispatch_commands (
				id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL REFERENCES dispatch_tasks(id),
				after_command_id TEXT REFERENCES dispatch_commands(id),
				position INTEGER NOT NULL CHECK(position > 0),
				version INTEGER NOT NULL,
				kind TEXT NOT NULL CHECK(kind IN ('review','resume','interrupt')),
				delivery TEXT NOT NULL CHECK(delivery IN ('Pending','Unconfirmed','Acknowledged','CancelledBeforeSend','Rejected')),
				record TEXT NOT NULL,
				UNIQUE(task_id,position),
				UNIQUE(kind,after_command_id)
			)`
			yield* sql`CREATE UNIQUE INDEX dispatch_initial_command ON dispatch_commands(task_id) WHERE kind = 'review'`
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

type OperationRow = { task_record: string; command_record: string }
type Stored = { task: Task; command: StoredCommand }

/** A restart is stored as the successor's review command anchored on the predecessor operation. */
export type ActionKind = 'resume' | 'interrupt' | 'restart'

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

	const decodeOperation = Effect.fn('TaskStore.decodeOperation')(function* (
		row: OperationRow | undefined,
	) {
		if (row === undefined) return undefined
		return {
			task: yield* decodeTask(row.task_record).pipe(storage('decodeTask')),
			command: yield* decodeCommand(row.command_record).pipe(storage('decodeCommand')),
		} satisfies Stored
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

	const readCommands = Effect.fn('TaskStore.readCommands')(function* (taskId: string) {
		const rows = yield* sql<{
			record: string
		}>`SELECT record FROM dispatch_commands WHERE task_id = ${taskId} ORDER BY position`.pipe(
			storage('commands'),
		)
		return yield* Effect.forEach(rows, (row) =>
			decodeCommand(row.record).pipe(storage('decodeCommand')),
		)
	})

	const get = Effect.fn('TaskStore.get')(function* (taskId: string) {
		const task = yield* getTask(taskId)
		const commands = yield* readCommands(taskId)
		return { task, commands }
	}, transaction('get'))

	const getOperation = Effect.fn('TaskStore.getOperation')(function* (operation: string) {
		const rows =
			yield* sql<OperationRow>`SELECT task.record AS task_record, command.record AS command_record
			FROM dispatch_commands AS command JOIN dispatch_tasks AS task ON task.id = command.task_id
			WHERE command.id = ${operation}`.pipe(storage('getOperation'))
		const stored = yield* decodeOperation(rows[0])
		if (stored === undefined) return yield* OperationNotFound.make({ operation })
		return stored
	})

	/** The latest non-interrupt command of the task currently mapped to the review key; closed tasks stay mapped. */
	const current = Effect.fn('TaskStore.current')(function* (reviewKey: string) {
		const rows =
			yield* sql<OperationRow>`SELECT task.record AS task_record, command.record AS command_record
			FROM dispatch_reviews AS review
			JOIN dispatch_tasks AS task ON task.id = review.task_id
			JOIN dispatch_commands AS command ON command.task_id = task.id
			WHERE review.review_key = ${reviewKey} AND command.kind != 'interrupt'
			ORDER BY command.position DESC LIMIT 1`.pipe(storage('current'))
		return yield* decodeOperation(rows[0])
	})

	const latestHead = Effect.fn('TaskStore.latestHead')(function* (taskId: string) {
		const rows = yield* sql<{
			id: string
		}>`SELECT id FROM dispatch_commands WHERE task_id = ${taskId} AND kind != 'interrupt'
			ORDER BY position DESC LIMIT 1`.pipe(storage('latestHead'))
		return rows[0]?.id
	})

	/** Durable receipt of the action taken after an operation, regardless of later progress. */
	const findAction = Effect.fn('TaskStore.findAction')(function* (kind: ActionKind, after: string) {
		const commandKind = kind === 'restart' ? 'review' : kind
		const rows =
			yield* sql<OperationRow>`SELECT task.record AS task_record, command.record AS command_record
			FROM dispatch_commands AS command JOIN dispatch_tasks AS task ON task.id = command.task_id
			WHERE command.kind = ${commandKind} AND command.after_command_id = ${after}`.pipe(
				storage('findAction'),
			)
		return yield* decodeOperation(rows[0])
	})

	const requireNoOutstanding = Effect.fn('TaskStore.requireNoOutstanding')(function* (
		taskId: string,
	) {
		const rows = yield* sql<{
			delivery: string
		}>`SELECT delivery FROM dispatch_commands WHERE task_id = ${taskId} AND delivery IN ('Pending','Unconfirmed')`.pipe(
			storage('outstanding'),
		)
		if (rows.some((row) => row.delivery === 'Unconfirmed'))
			return yield* TaskConflict.make({ code: 'delivery_unconfirmed' })
		if (rows.length > 0) return yield* TaskConflict.make({ code: 'operation_pending' })
	})

	const requireAnchor = Effect.fn('TaskStore.requireAnchor')(function* (
		operation: string,
		allowClosed: boolean,
	) {
		const stored = yield* getOperation(operation)
		if (stored.command.kind === 'interrupt') return yield* OperationNotFound.make({ operation })
		const head = yield* current(stored.task.reviewKey)
		if (head?.command.id !== operation) return yield* TaskConflict.make({ code: 'stale_operation' })
		if (!allowClosed && stored.task.submissions._tag === 'Closed')
			return yield* TaskConflict.make({ code: 'task_closed' })
		return stored
	})

	/** Service precheck of the anchor's position; append and restart repeat it and also refuse outstanding deliveries inside their transactions. */
	const checkAnchor = Effect.fn('TaskStore.checkAnchor')(function* (
		operation: string,
		options: { readonly allowClosed?: boolean } = {},
	) {
		return yield* requireAnchor(operation, options.allowClosed ?? false)
	}, transaction('checkAnchor'))

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

	const insertCommand = Effect.fn('TaskStore.insertCommand')(function* (command: StoredCommand) {
		yield* sql`INSERT INTO dispatch_commands (id,task_id,after_command_id,position,version,kind,delivery,record)
			SELECT ${command.id},${command.taskId},${command.afterCommandId ?? null},COALESCE(MAX(position),0)+1,${command.version},${command.kind},${command.delivery._tag},${JSON.stringify(command)}
			FROM dispatch_commands WHERE task_id = ${command.taskId}`.pipe(storage('insertCommand'))
	})

	const insertTaskRow = Effect.fn('TaskStore.insertTaskRow')(function* (task: Task) {
		yield* sql`INSERT INTO dispatch_tasks (id,created_at,review_key,submissions,worker_id,record) VALUES (${task.id},${task.createdAt},${task.reviewKey},${task.submissions._tag},NULL,${JSON.stringify(task)})`.pipe(
			storage('insertTask'),
		)
	})

	const insertTask = Effect.fn('TaskStore.insertTask')(function* (
		task: Task,
		command: StoredCommand,
	) {
		const existing = yield* current(task.reviewKey)
		if (existing !== undefined) return existing

		yield* insertTaskRow(task)
		yield* insertCommand(command)
		yield* sql`INSERT INTO dispatch_reviews (review_key,task_id) VALUES (${task.reviewKey},${task.id})`.pipe(
			storage('mapReview'),
		)
		return { task, command }
	}, transaction('insert'))

	/** Creates the PR's first task, or returns the current operation already mapped to its review key. */
	const insert = Effect.fn('TaskStore.insert')(function* (task: Task, command: StoredCommand) {
		const stored = yield* insertTask(task, command)
		yield* notify(stored.task.id, true)
		return stored
	}, Effect.uninterruptible)

	const appendCommand = Effect.fn('TaskStore.appendCommand')(function* (command: StoredCommand) {
		const { kind, afterCommandId } = command
		if (kind === 'review' || afterCommandId === undefined)
			return yield* Effect.die(InvalidStoreRequest.make({ reason: 'append_command' }))
		const existing = yield* findAction(kind, afterCommandId)
		if (existing !== undefined) return existing

		const anchor = yield* requireAnchor(afterCommandId, kind === 'interrupt')
		if (anchor.task.id !== command.taskId)
			return yield* Effect.die(InvalidStoreRequest.make({ reason: 'append_command' }))
		yield* requireNoOutstanding(anchor.task.id)
		yield* insertCommand(command)
		return { task: anchor.task, command }
	}, transaction('append'))

	/** Returns the action already taken after the anchor, if any. Callers check native settlement first; this rechecks only durable anchor and outbox facts. */
	const append = Effect.fn('TaskStore.append')(function* (command: StoredCommand) {
		const stored = yield* appendCommand(command)
		yield* notify(stored.task.id, true)
		return stored
	}, Effect.uninterruptible)

	const restartTask = Effect.fn('TaskStore.restartTask')(function* (
		after: string,
		task: Task,
		command: StoredCommand,
	) {
		const existing = yield* findAction('restart', after)
		if (existing !== undefined) return { stored: existing, predecessor: undefined }

		const anchor = yield* requireAnchor(after, true)
		if (anchor.task.reviewKey !== task.reviewKey || command.kind !== 'review')
			return yield* Effect.die(InvalidStoreRequest.make({ reason: 'restart_successor' }))
		yield* requireNoOutstanding(anchor.task.id)

		const successor: StoredCommand = { ...command, afterCommandId: after }
		yield* writeTask({ ...anchor.task, submissions: { _tag: 'Closed' } })
		yield* insertTaskRow(task)
		yield* insertCommand(successor)
		yield* sql`UPDATE dispatch_reviews SET task_id = ${task.id} WHERE review_key = ${task.reviewKey}`.pipe(
			storage('remapReview'),
		)
		return { stored: { task, command: successor }, predecessor: anchor.task.id }
	}, transaction('restart'))

	/** Closes the predecessor without cancelling native work and maps the review key to the successor. The successor's review command is stored with `after` as its anchor, which is the durable restart receipt. */
	const restart = Effect.fn('TaskStore.restart')(function* (
		after: string,
		task: Task,
		command: StoredCommand,
	) {
		const { stored, predecessor } = yield* restartTask(after, task, command)
		if (predecessor !== undefined) yield* notify(predecessor, false)
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

	const closeSubmissions = Effect.fn('TaskStore.closeSubmissions')(function* (operation: string) {
		const stored = yield* getOperation(operation)
		if (stored.command.kind === 'interrupt') return yield* OperationNotFound.make({ operation })
		if (stored.task.submissions._tag === 'Closed') return stored.task
		if ((yield* latestHead(stored.task.id)) !== operation)
			return yield* TaskConflict.make({ code: 'stale_operation' })

		const task: Task = { ...stored.task, submissions: { _tag: 'Closed' } }
		yield* writeTask(task)
		for (const command of yield* readCommands(task.id)) {
			if (command.delivery._tag !== 'Pending' || command.kind === 'interrupt') continue
			const cancelled = yield* transition(command, { _tag: 'CancelledBeforeSend' }).pipe(
				Effect.orDie,
			)
			yield* writeCommand(cancelled)
		}
		return task
	}, transaction('close'))

	/** Closing an already closed task through any of its operations returns it unchanged. */
	const close = Effect.fn('TaskStore.close')(function* (operation: string) {
		const task = yield* closeSubmissions(operation)
		yield* notify(task.id, true)
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
		getOperation,
		current,
		findAction,
		checkAnchor,
		insert,
		append,
		restart,
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

/** Mutations commit before notifying; subscribe before reading to observe every later commit. Changes signal new commands, closes, restarts, and released capacity. */
export class TaskStore extends Context.Service<TaskStore, Effect.Success<typeof make>>()(
	'pipeline/tasks/TaskStore',
) {}
export const taskStoreLayer = (filename: string) =>
	Layer.effect(TaskStore, make).pipe(
		Layer.provide(migrations.pipe(Layer.provideMerge(SqliteClient.layer({ filename })))),
	)
