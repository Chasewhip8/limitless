import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-node'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'

export const raw = <A extends object>(filename: string, query: string) =>
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

export const releasedDatabase = (filename: string, rows: ReadonlyArray<string>) =>
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

/** Schema, migration bookkeeping, and every row of every table. */
export const databaseState = async (filename: string) => {
	const schema = await raw<{ type: string; name: string; sql: string | null }>(
		filename,
		'SELECT type, name, sql FROM sqlite_master ORDER BY name',
	)
	const tables = schema.filter((entry) => entry.type === 'table').map((entry) => entry.name)
	const rows = await Promise.all(
		tables.map((table) => raw(filename, `SELECT * FROM "${table}" ORDER BY rowid`)),
	)
	return { schema, rows }
}
