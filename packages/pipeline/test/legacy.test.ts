import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { PipelineSettings } from '../config'
import { inspectLegacy, migrateLegacy } from '../migration'
import type { LegacyMigrationPlan } from '../tasks/legacy'
import { TaskStore, taskStoreLayer } from '../tasks/store'
import type { Worker } from '../worker/schema'
import { databaseState, raw, releasedDatabase } from './released'

let directory = ''
beforeEach(async () => {
	directory = await mkdtemp('/tmp/opencode/pipeline-legacy-')
})
afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})

const taskId = 'a1d4ce36-4513-4148-acaa-4393008b8330'
const reviewId = '1b95cf11-77d4-4e56-b54a-800d7a412ddd'
const resumeId = '5e859961-24f1-4275-a3ee-0d2b625c3860'
const compact = (id: string) => id.replaceAll('-', '')
const sessionId = `ses_pipeline${compact(taskId)}`
const workspaceId = `wrk_pipeline${compact(taskId)}`
const pr = 'https://github.com/Chasewhip8/ai-test/pull/2'
const reviewKey = '1158510034:2'

const worker: Worker = {
	id: 'personal-vm',
	url: 'https://personal-vm.example.ts.net',
	credentialFile: '/tmp/opencode/test-password',
	controlDirectory: '/home/test/.local/state/capsule/control',
	system: 'x86_64-linux',
	capacity: 1,
	openCodeVersion: '2.2.7',
}
const assignment = {
	workerId: worker.id,
	workerUrl: worker.url,
	controlDirectory: worker.controlDirectory,
	storageId: 'b40d9620185b120b9d9a45f77f253a33',
	workspaceId,
	sessionId,
	directory: `/home/test/.local/share/capsule/checkouts/${workspaceId}/checkout`,
}

/** Records as written by the released 0001 coordinator, shaped like the deployed canary. */
const legacyTask = {
	id: taskId,
	createdAt: 1_762_900_000_000,
	request: { kind: 'review', pr, system: 'x86_64-linux' },
	submissions: { _tag: 'Open' },
	placement: { _tag: 'Assigned', assignment },
}
const acknowledged = (id: string) => ({
	_tag: 'Acknowledged',
	nativeRef: { sessionId, messageId: `msg_pipeline${compact(id)}` },
})
const legacyReview = {
	id: reviewId,
	taskId,
	createdAt: 1_762_900_000_100,
	version: 3,
	kind: 'review',
	messageId: `msg_pipeline${compact(reviewId)}`,
	requestHash: 'hash-review',
	delivery: acknowledged(reviewId) as object,
}
const legacyResume = {
	id: resumeId,
	taskId,
	createdAt: 1_762_900_900_000,
	version: 2,
	kind: 'resume',
	afterCommandId: reviewId,
	messageId: `msg_pipeline${compact(resumeId)}`,
	requestHash: 'hash-resume',
	delivery: acknowledged(resumeId) as object,
}

const quote = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'`
const taskRow = (task: typeof legacyTask, workerId: string | null = worker.id) =>
	`INSERT INTO dispatch_tasks VALUES ('${task.id}', ${task.createdAt}, '${task.submissions._tag}', ${workerId === null ? 'NULL' : `'${workerId}'`}, ${quote(task)})`
const commandRow = (command: typeof legacyResume | typeof legacyReview, position: number) => {
	const after = 'afterCommandId' in command ? `'${command.afterCommandId}'` : 'NULL'
	const delivery = (command.delivery as { _tag: string })._tag
	return `INSERT INTO dispatch_commands VALUES ('${command.id}', '${command.taskId}', ${after}, ${position}, ${command.version}, '${command.kind}', '${delivery}', '${command.requestHash}', ${quote(command)})`
}
const canary = (
	options: {
		task?: typeof legacyTask
		resume?: typeof legacyResume
		workerId?: string | null
		extra?: ReadonlyArray<string>
	} = {},
) => {
	const resume = options.resume ?? legacyResume
	return [
		taskRow(options.task ?? legacyTask, options.workerId),
		commandRow(legacyReview, 1),
		commandRow(resume, 2),
		`INSERT INTO dispatch_keys VALUES ('caller-review', 'hash-review', '${taskId}', '${reviewId}')`,
		`INSERT INTO dispatch_keys VALUES ('caller-resume', '${resume.requestHash}', '${taskId}', '${resumeId}')`,
		...(options.extra ?? []),
	]
}

const settings = (database: string, workers = [worker]): PipelineSettings => ({
	host: '127.0.0.1',
	port: 4848,
	database,
	apiTokenFile: '/tmp/opencode/test-api-token',
	githubTokenFile: null,
	pollIntervalMs: 60_000,
	queueTimeoutMs: 60_000,
	workers,
})

const node = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

const prepare = async (
	rows: ReadonlyArray<string>,
	review: Partial<LegacyMigrationPlan['reviews'][number]> = {},
) => {
	const database = path.join(directory, 'pipeline.sqlite')
	await releasedDatabase(database, rows)
	const inspected = await node(inspectLegacy(settings(database)))
	const plan = {
		format: 'pipeline-legacy-migration/1',
		snapshot: inspected.legacy?.snapshot ?? '',
		reviews: [{ taskId, repositoryId: 1158510034, reviewKey, ...review }],
	}
	return { database, inspected, plan }
}

const migrate = async (database: string, plan: object, workers = [worker]) => {
	const planFile = path.join(directory, 'plan.json')
	await writeFile(planFile, JSON.stringify(plan))
	const backup = path.join(directory, `backup-${Date.now()}-${Math.random()}.sqlite`)
	return {
		backup,
		migration: migrateLegacy(settings(database, workers), { plan: planFile, backup }),
	}
}

test('a reviewed plan converts the acknowledged canary atomically and reopening is a no-op', async () => {
	const { database, inspected, plan } = await prepare(canary())
	const before = await databaseState(database)
	expect(inspected).toEqual({
		migration: 1,
		legacy: {
			snapshot: plan.snapshot,
			tasks: [{ id: taskId, pr, submissions: 'Open', workerId: worker.id }],
			commands: [
				{ id: reviewId, taskId, position: 1, version: 3, kind: 'review', delivery: 'Acknowledged' },
				{ id: resumeId, taskId, position: 2, version: 2, kind: 'resume', delivery: 'Acknowledged' },
			],
			keys: 2,
			leases: 0,
		},
	})
	const startup = await Effect.runPromise(
		Effect.provide(Effect.service(TaskStore), taskStoreLayer(database)).pipe(Effect.flip),
	)
	expect(startup).toMatchObject({ cause: { _tag: 'LegacyStateRefused' } })

	const { backup, migration } = await migrate(database, plan)
	const current = {
		reviewKey,
		taskId,
		operation: resumeId,
		kind: 'resume',
		delivery: 'Acknowledged',
	}
	expect(await node(migration)).toEqual({
		applied: [[2, 'operations']],
		backup,
		reviews: [current],
		work: [],
	})
	expect(await databaseState(backup)).toEqual(before)

	expect(await raw(database, 'SELECT * FROM dispatch_tasks')).toEqual([
		{
			id: taskId,
			created_at: legacyTask.createdAt,
			review_key: reviewKey,
			submissions: 'Open',
			worker_id: worker.id,
			record: JSON.stringify({ ...legacyTask, reviewKey }),
		},
	])
	expect(await raw(database, 'SELECT * FROM dispatch_reviews')).toEqual([
		{ review_key: reviewKey, task_id: taskId },
	])
	expect(await raw(database, 'SELECT * FROM dispatch_commands ORDER BY position')).toEqual(
		[legacyReview, legacyResume].map((command, index) => ({
			id: command.id,
			task_id: taskId,
			after_command_id: index === 0 ? null : reviewId,
			position: index + 1,
			version: command.version,
			kind: command.kind,
			delivery: 'Acknowledged',
			record: JSON.stringify(command),
		})),
	)
	expect(await raw(database, 'SELECT * FROM dispatch_leases')).toEqual([])
	const [archive] = await raw<{ digest: string; snapshot: string }>(
		database,
		'SELECT * FROM dispatch_legacy_snapshots',
	)
	expect(archive?.digest).toBe(plan.snapshot)
	expect(
		`sha256:${createHash('sha256')
			.update(archive?.snapshot ?? '')
			.digest('hex')}`,
	).toBe(plan.snapshot)
	expect(archive?.snapshot).toContain('caller-resume')

	const stored = await Effect.runPromise(
		Effect.gen(function* () {
			const store = yield* TaskStore
			return {
				view: yield* store.get(taskId),
				anchor: yield* store.checkAnchor(resumeId),
				action: yield* store.findAction('resume', reviewId),
			}
		}).pipe(Effect.provide(taskStoreLayer(database))),
	)
	expect(stored.view).toEqual({
		task: {
			id: taskId,
			createdAt: legacyTask.createdAt,
			request: { pr },
			reviewKey,
			submissions: { _tag: 'Open' },
			placement: { _tag: 'Assigned', assignment },
		},
		commands: [legacyReview, legacyResume].map(({ requestHash: _, ...command }) => command),
	})
	expect(stored.anchor.command.id).toBe(resumeId)
	expect(stored.action?.command.id).toBe(resumeId)

	const converted = await databaseState(database)
	const rerun = await migrate(database, plan)
	expect(await node(rerun.migration)).toEqual({ applied: [], reviews: [current], work: [] })
	expect(existsSync(rerun.backup)).toBe(false)
	expect(await databaseState(database)).toEqual(converted)
})

const unconfirmed = {
	...legacyResume,
	version: 1,
	delivery: { _tag: 'Unconfirmed', payload: { _tag: 'Resume', prompt: 'Continue.' } },
}
const refusals: ReadonlyArray<{
	name: string
	rows?: ReadonlyArray<string>
	review?: Partial<LegacyMigrationPlan['reviews'][number]>
	snapshot?: string
	workers?: ReadonlyArray<Worker>
	reason: string
}> = [
	{
		name: 'a different snapshot',
		snapshot: `sha256:${'0'.repeat(64)}`,
		reason: 'snapshot_mismatch',
	},
	{
		name: 'an unmapped task',
		review: { taskId: '00000000-0000-4000-8000-000000000000' },
		reason: 'plan_mismatch',
	},
	{
		name: 'another PR number',
		review: { reviewKey: '1158510034:3' },
		reason: 'review_key_mismatch',
	},
	{
		name: 'an unconfirmed resume',
		rows: canary({ resume: unconfirmed }),
		reason: 'delivery_outstanding',
	},
	{
		name: 'a pending resume',
		rows: canary({
			resume: {
				...unconfirmed,
				delivery: { ...unconfirmed.delivery, _tag: 'Pending', step: 'send' },
			},
		}),
		reason: 'delivery_outstanding',
	},
	{
		name: 'a held lease',
		rows: canary({
			extra: [`INSERT INTO dispatch_leases VALUES ('${worker.id}', 0, '${taskId}')`],
		}),
		reason: 'lease_held',
	},
	{
		name: 'an interrupt',
		rows: canary({
			extra: [
				`INSERT INTO dispatch_commands VALUES ('${'c'.repeat(8)}-cccc-4ccc-8ccc-${'c'.repeat(12)}', '${taskId}', '${resumeId}', 3, 2, 'interrupt', 'Acknowledged', 'hash-stop', '{}')`,
			],
		}),
		reason: 'unsupported_commands',
	},
	{
		name: 'a closed task',
		rows: canary({ task: { ...legacyTask, submissions: { _tag: 'Closed' } } }),
		reason: 'unsupported_task',
	},
	{
		name: 'an unassigned task',
		rows: canary({
			task: { ...legacyTask, placement: { _tag: 'Unassigned' } as never },
			workerId: null,
		}),
		reason: 'unsupported_placement',
	},
	{
		name: 'a foreign session',
		rows: canary({
			task: {
				...legacyTask,
				placement: { _tag: 'Assigned', assignment: { ...assignment, sessionId: 'ses_other' } },
			},
		}),
		reason: 'unsupported_placement',
	},
	{
		name: 'an unconfigured worker',
		workers: [{ ...worker, url: 'https://elsewhere.example.ts.net' }],
		reason: 'unsupported_placement',
	},
]

test.each(refusals)('a plan refuses $name and leaves the database unchanged', async (refusal) => {
	const { database, plan } = await prepare(refusal.rows ?? canary(), refusal.review)
	const before = await databaseState(database)
	const { migration } = await migrate(
		database,
		{ ...plan, snapshot: refusal.snapshot ?? plan.snapshot },
		[...(refusal.workers ?? [worker])],
	)

	expect(await node(migration.pipe(Effect.flip))).toMatchObject({
		_tag: 'LegacyMigrationRefused',
		reason: refusal.reason,
	})
	expect(await databaseState(database)).toEqual(before)
})

test('migration never creates a missing database or accepts an unreviewed plan', async () => {
	const database = path.join(directory, 'missing.sqlite')
	const { migration } = await migrate(database, {
		format: 'pipeline-legacy-migration/1',
		snapshot: `sha256:${'0'.repeat(64)}`,
		reviews: [{ taskId, repositoryId: 1158510034, reviewKey }],
	})
	expect(await node(migration.pipe(Effect.flip))).toMatchObject({
		_tag: 'LegacyMigrationUnavailable',
	})
	expect(existsSync(database)).toBe(false)

	const prepared = await prepare(canary())
	const invalid = await migrate(prepared.database, { ...prepared.plan, reviews: [] })
	expect(await node(invalid.migration.pipe(Effect.flip))).toMatchObject({
		_tag: 'LegacyMigrationUnavailable',
	})
})
