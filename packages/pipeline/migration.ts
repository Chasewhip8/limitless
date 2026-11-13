import path from 'node:path'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { Effect, FileSystem, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import type { PipelineSettings } from './config'
import {
	convertLegacyState,
	LegacyMigrationPlan,
	LegacyMigrationRefused,
	legacySummary,
	readLegacySnapshot,
} from './tasks/legacy'
import { migrateTaskStore, TaskStore, taskStoreLayer } from './tasks/store'

export class LegacyMigrationUnavailable extends Schema.TaggedError<LegacyMigrationUnavailable>()(
	'LegacyMigrationUnavailable',
	{ message: Schema.String },
	{ description: 'The migration did not start; the database is unchanged.' },
) {}
const unavailable = (message: string) => LegacyMigrationUnavailable.make({ message })

const releasedMigration = 1

const latestMigration = Effect.fn('PipelineMigration.latest')(function* () {
	const sql = yield* SqlClient.SqlClient
	const tables =
		yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`
	if (tables.length === 0) return 0
	const [row] = yield* sql<{
		latest: number | null
	}>`SELECT max(migration_id) AS latest FROM effect_sql_migrations`
	return row?.latest ?? 0
})

const requireDatabase = Effect.fn('PipelineMigration.requireDatabase')(function* (file: string) {
	const fs = yield* FileSystem.FileSystem
	if (!(yield* fs.exists(file)))
		return yield* unavailable(`Pipeline database ${file} does not exist`)
})

const loadPlan = Effect.fn('PipelineMigration.loadPlan')(function* (file: string) {
	const fs = yield* FileSystem.FileSystem
	const json = yield* fs
		.readFileString(file)
		.pipe(Effect.mapError(() => unavailable(`Cannot read migration plan ${file}`)))
	return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LegacyMigrationPlan), {
		onExcessProperty: 'error',
	})(json).pipe(Effect.mapError((error) => unavailable(`Invalid migration plan: ${error.message}`)))
})

/** Reads released legacy state without writing; its snapshot digest is the value a reviewed plan must name. */
export const inspectLegacy = Effect.fn('PipelineMigration.inspect')(function* (
	settings: PipelineSettings,
) {
	yield* requireDatabase(settings.database)
	return yield* Effect.gen(function* () {
		const migration = yield* latestMigration()
		if (migration !== releasedMigration) return { migration }
		const snapshot = yield* readLegacySnapshot()
		return { migration, legacy: legacySummary(snapshot) }
	}).pipe(Effect.provide(SqliteClient.layer({ filename: settings.database, readonly: true })))
})

const convert = Effect.fn('PipelineMigration.convert')(function* (
	settings: PipelineSettings,
	plan: LegacyMigrationPlan,
	backup: string,
) {
	const fs = yield* FileSystem.FileSystem
	const client = yield* SqliteClient.SqliteClient
	const migration = yield* latestMigration()
	if (migration > releasedMigration) return { applied: [] }
	if (migration !== releasedMigration)
		return yield* unavailable('The database does not hold the released 0001 schema')
	if (yield* fs.exists(backup)) return yield* unavailable(`Backup ${backup} already exists`)

	yield* client.backup(backup).pipe(Effect.mapError(() => unavailable(`Backup ${backup} failed`)))
	const applied = yield* migrateTaskStore(convertLegacyState(plan, settings.workers)).pipe(
		Effect.catchTag('MigrationError', (error) =>
			Effect.fail(error.cause instanceof LegacyMigrationRefused ? error.cause : error),
		),
	)
	return { applied, backup }
})

const verify = Effect.fn('PipelineMigration.verify')(function* (plan: LegacyMigrationPlan) {
	const store = yield* TaskStore
	const reviews = yield* Effect.forEach(plan.reviews, (review) =>
		Effect.gen(function* () {
			const current = yield* store.current(review.reviewKey)
			return {
				reviewKey: review.reviewKey,
				taskId: current?.task.id,
				operation: current?.command.id,
				kind: current?.command.kind,
				delivery: current?.command.delivery._tag,
			}
		}),
	)
	return { reviews, work: yield* store.work() }
})

/**
 * Backs up a released legacy database and converts it with a reviewed plan, then reopens it as ordinary
 * startup does. Stop every coordinator using the database first. A database that already completed 0002
 * is reopened and reported without another backup.
 */
export const migrateLegacy = Effect.fn('PipelineMigration.migrate')(function* (
	settings: PipelineSettings,
	options: { readonly plan: string; readonly backup: string },
) {
	const plan = yield* loadPlan(options.plan)
	yield* requireDatabase(settings.database)
	const converted = yield* convert(settings, plan, path.resolve(options.backup)).pipe(
		Effect.provide(SqliteClient.layer({ filename: settings.database })),
	)
	const verified = yield* verify(plan).pipe(Effect.provide(taskStoreLayer(settings.database)))
	return { ...converted, ...verified }
})
