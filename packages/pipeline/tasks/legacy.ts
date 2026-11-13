import { createHash } from 'node:crypto'
import path from 'node:path'
import { Effect, Option, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { NativeReference, type Worker } from '../worker/schema'
import { PullRequestUrl } from '../workflow'
import { pipelineMessageId, StoredCommand } from './command'
import { pinnedWorker, pipelineSessionId, pipelineWorkspaceId } from './placement'
import { Assignment, CommandId, pullRequestReviewKey, ReviewKey, Task, TaskId } from './schema'

export const LegacyMigrationPlan = Schema.Struct({
	format: Schema.Literal('pipeline-legacy-migration/1'),
	snapshot: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)).annotate({
		description:
			'Digest reported by `pipeline legacy inspect` for the exact reviewed legacy database state.',
	}),
	reviews: Schema.Array(
		Schema.Struct({
			taskId: TaskId,
			repositoryId: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
				description: 'Numeric GitHub ID of the pull request base repository.',
			}),
			reviewKey: ReviewKey,
		}),
	).check(Schema.isMinLength(1)),
}).annotate({
	description:
		'Reviewed conversion of released 0001 dispatch state. Every legacy task needs exactly one entry; its review key must name the PR its request records.',
})
export type LegacyMigrationPlan = typeof LegacyMigrationPlan.Type
type PlannedReview = LegacyMigrationPlan['reviews'][number]

export class LegacyMigrationRefused extends Schema.TaggedError<LegacyMigrationRefused>()(
	'LegacyMigrationRefused',
	{
		reason: Schema.Literals([
			'snapshot_mismatch',
			'plan_mismatch',
			'lease_held',
			'delivery_outstanding',
			'unsupported_task',
			'unsupported_placement',
			'unsupported_commands',
			'review_key_mismatch',
			'inconsistent_row',
		]),
		message: Schema.String,
	},
	{
		description:
			'The legacy database differs from the reviewed plan or the supported conversion: open Capsule-assigned tasks whose review and resume chain is fully acknowledged, with no held leases. The migration transaction rolls back and leaves the database unchanged.',
	},
) {}
const refuse = (reason: LegacyMigrationRefused['reason'], message: string) =>
	LegacyMigrationRefused.make({ reason, message })

type TaskRow = {
	id: string
	created_at: number
	submissions: string
	worker_id: string | null
	record: string
}
type CommandRow = {
	id: string
	task_id: string
	after_command_id: string | null
	position: number
	version: number
	kind: string
	delivery: string
	request_hash: string
	record: string
}
type KeyRow = { key: string; request_hash: string; task_id: string; command_id: string }
type LeaseRow = { worker_id: string; slot: number; task_id: string }

/** Every column of the released 0001 tables, in a fixed row order, so equal state always has an equal digest. */
export const readLegacySnapshot = Effect.fn('LegacyMigration.readSnapshot')(function* () {
	const sql = yield* SqlClient.SqlClient
	const tasks =
		yield* sql<TaskRow>`SELECT id,created_at,submissions,worker_id,record FROM dispatch_tasks ORDER BY id`
	const commands =
		yield* sql<CommandRow>`SELECT id,task_id,after_command_id,position,version,kind,delivery,request_hash,record
			FROM dispatch_commands ORDER BY task_id,position`
	const keys =
		yield* sql<KeyRow>`SELECT key,request_hash,task_id,command_id FROM dispatch_keys ORDER BY key`
	const leases =
		yield* sql<LeaseRow>`SELECT worker_id,slot,task_id FROM dispatch_leases ORDER BY worker_id,slot`
	const canonical = JSON.stringify({
		tasks: tasks.map((row) => [row.id, row.created_at, row.submissions, row.worker_id, row.record]),
		commands: commands.map((row) => [
			row.id,
			row.task_id,
			row.after_command_id,
			row.position,
			row.version,
			row.kind,
			row.delivery,
			row.request_hash,
			row.record,
		]),
		keys: keys.map((row) => [row.key, row.request_hash, row.task_id, row.command_id]),
		leases: leases.map((row) => [row.worker_id, row.slot, row.task_id]),
	})
	const digest = `sha256:${createHash('sha256').update(canonical).digest('hex')}`
	return { tasks, commands, keys, leases, canonical, digest }
})
export type LegacySnapshot = Effect.Success<ReturnType<typeof readLegacySnapshot>>

const RecordedRequest = Schema.fromJsonString(
	Schema.Struct({ request: Schema.Struct({ pr: Schema.String }) }),
)

/** Identifiers and delivery states for plan review, without command payloads or native references. */
export function legacySummary(snapshot: LegacySnapshot) {
	return {
		snapshot: snapshot.digest,
		tasks: snapshot.tasks.map((row) => ({
			id: row.id,
			pr: Option.getOrUndefined(
				Option.map(
					Schema.decodeUnknownOption(RecordedRequest)(row.record),
					({ request }) => request.pr,
				),
			),
			submissions: row.submissions,
			workerId: row.worker_id,
		})),
		commands: snapshot.commands.map((row) => ({
			id: row.id,
			taskId: row.task_id,
			position: row.position,
			version: row.version,
			kind: row.kind,
			delivery: row.delivery,
		})),
		keys: snapshot.keys.length,
		leases: snapshot.leases.length,
	}
}

const LegacyTask = Schema.Struct({
	id: TaskId,
	createdAt: Schema.Number,
	request: Schema.Struct({
		kind: Schema.Literal('review'),
		pr: PullRequestUrl,
		system: Schema.optionalKey(Schema.Literals(['x86_64-linux', 'aarch64-linux'])),
	}),
	submissions: Schema.Union([Schema.TaggedStruct('Open', {}), Schema.TaggedStruct('Closed', {})]),
	placement: Schema.Unknown,
})
const AssignedPlacement = Schema.TaggedStruct('Assigned', { assignment: Assignment })
const LegacyCommand = Schema.Struct({
	id: CommandId,
	taskId: TaskId,
	createdAt: Schema.Number,
	version: Schema.Int,
	kind: Schema.Literals(['review', 'resume']),
	afterCommandId: Schema.optionalKey(CommandId),
	messageId: Schema.String,
	requestHash: Schema.String,
	delivery: Schema.TaggedStruct('Acknowledged', { nativeRef: NativeReference }),
})
const strict = { onExcessProperty: 'error' } as const
const decodeLegacyTask = Schema.decodeUnknownEffect(Schema.fromJsonString(LegacyTask), strict)
const decodeAssignedPlacement = Schema.decodeUnknownEffect(AssignedPlacement, strict)
const decodeLegacyCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(LegacyCommand), strict)
const decodeTask = Schema.decodeUnknownEffect(Schema.fromJsonString(Task))
const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredCommand))

function planProblem(snapshot: LegacySnapshot, plan: LegacyMigrationPlan): string | undefined {
	const planned = new Set(plan.reviews.map((review) => review.taskId))
	if (planned.size !== plan.reviews.length) return 'The plan lists a task more than once'
	if (new Set(plan.reviews.map((review) => review.reviewKey)).size !== plan.reviews.length)
		return 'The plan maps several tasks to one review key'
	const stored = snapshot.tasks.map((row) => row.id)
	if (stored.length !== planned.size || stored.some((id) => !planned.has(id)))
		return `The plan must map exactly the stored tasks: ${stored.join(', ')}`
}

function referenceProblem(snapshot: LegacySnapshot): string | undefined {
	const tasks = new Set(snapshot.tasks.map((row) => row.id))
	const orphan = snapshot.commands.find((row) => !tasks.has(row.task_id))
	if (orphan !== undefined) return `Command ${orphan.id} belongs to no stored task`
	for (const key of snapshot.keys) {
		const command = snapshot.commands.find((row) => row.id === key.command_id)
		if (command?.task_id !== key.task_id || command.request_hash !== key.request_hash)
			return `An idempotency key does not match command ${key.command_id}`
	}
}

function placementProblem(
	row: TaskRow,
	assignment: Assignment,
	workers: ReadonlyArray<Worker>,
): string | undefined {
	const { directory } = assignment
	if (row.worker_id !== assignment.workerId) return 'its worker column differs from its assignment'
	if (assignment.workspaceId !== pipelineWorkspaceId(row.id))
		return 'its workspace is not the Pipeline workspace'
	if (assignment.sessionId !== pipelineSessionId(row.id))
		return 'its session is not the Pipeline session'
	if (assignment.storageId.length === 0) return 'it has no Capsule storage identity'
	if (!path.isAbsolute(assignment.controlDirectory))
		return 'its Capsule control directory is not absolute'
	if (
		!path.isAbsolute(directory) ||
		path.normalize(directory) !== directory ||
		path.basename(directory) !== 'checkout' ||
		path.basename(path.dirname(directory)) !== assignment.workspaceId
	)
		return 'its directory is not the Capsule workspace checkout'
	if (pinnedWorker(workers, assignment) === undefined)
		return 'its worker, URL and control directory are not a configured worker'
}

const pullRequestNumber = (pr: string) => Number(/\/pull\/([1-9][0-9]*)\/?$/.exec(pr)?.[1])

const convertTask = Effect.fn('LegacyMigration.convertTask')(function* (
	row: TaskRow,
	review: PlannedReview,
	workers: ReadonlyArray<Worker>,
) {
	const legacy = yield* decodeLegacyTask(row.record).pipe(
		Effect.mapError(() => refuse('unsupported_task', `Task ${row.id} has an unsupported record`)),
	)
	if (
		legacy.id !== row.id ||
		legacy.createdAt !== row.created_at ||
		legacy.submissions._tag !== row.submissions
	)
		return yield* refuse('inconsistent_row', `Task ${row.id} differs from its indexed columns`)
	if (legacy.submissions._tag !== 'Open')
		return yield* refuse('unsupported_task', `Task ${row.id} is closed`)

	const { assignment } = yield* decodeAssignedPlacement(legacy.placement).pipe(
		Effect.mapError(() =>
			refuse('unsupported_placement', `Task ${row.id} has no Capsule assignment`),
		),
	)
	const problem = placementProblem(row, assignment, workers)
	if (problem !== undefined)
		return yield* refuse('unsupported_placement', `Task ${row.id} placement: ${problem}`)

	const reviewKey = pullRequestReviewKey(review.repositoryId, pullRequestNumber(legacy.request.pr))
	if (review.reviewKey !== reviewKey)
		return yield* refuse(
			'review_key_mismatch',
			`Task ${row.id} reviews ${legacy.request.pr}; its review key must be ${reviewKey}`,
		)

	const record = JSON.stringify({ ...legacy, reviewKey })
	const task = yield* decodeTask(record).pipe(
		Effect.mapError(() => refuse('unsupported_task', `Task ${row.id} cannot be converted`)),
	)
	return { task, assignment, record }
})

const convertCommand = Effect.fn('LegacyMigration.convertCommand')(function* (
	row: CommandRow,
	previous: CommandRow | undefined,
	assignment: Assignment,
) {
	const unsupported = refuse(
		'unsupported_commands',
		`Command ${row.id} is not part of an acknowledged review and resume chain`,
	)
	const kind = previous === undefined ? 'review' : 'resume'
	if (
		row.kind !== kind ||
		row.delivery !== 'Acknowledged' ||
		row.position !== (previous?.position ?? 0) + 1 ||
		row.after_command_id !== (previous?.id ?? null)
	)
		return yield* unsupported

	const legacy = yield* decodeLegacyCommand(row.record).pipe(Effect.mapError(() => unsupported))
	if (
		legacy.id !== row.id ||
		legacy.taskId !== row.task_id ||
		legacy.version !== row.version ||
		legacy.kind !== row.kind ||
		(legacy.afterCommandId ?? null) !== row.after_command_id ||
		legacy.requestHash !== row.request_hash
	)
		return yield* refuse('inconsistent_row', `Command ${row.id} differs from its indexed columns`)
	const { nativeRef } = legacy.delivery
	if (
		legacy.messageId !== pipelineMessageId(row.id) ||
		nativeRef.messageId !== legacy.messageId ||
		nativeRef.sessionId !== assignment.sessionId
	)
		return yield* refuse(
			'unsupported_commands',
			`Command ${row.id} was not acknowledged as its Pipeline message in the assigned session`,
		)

	const command = yield* decodeCommand(row.record).pipe(Effect.mapError(() => unsupported))
	return { command, position: row.position, record: row.record }
})

const convertCommands = Effect.fn('LegacyMigration.convertCommands')(function* (
	taskId: string,
	rows: ReadonlyArray<CommandRow>,
	assignment: Assignment,
) {
	if (rows.length === 0)
		return yield* refuse('unsupported_commands', `Task ${taskId} has no review command`)
	return yield* Effect.forEach(rows, (row, index) =>
		convertCommand(row, rows[index - 1], assignment),
	)
})

/**
 * Reads and validates released 0001 state against a reviewed plan, before migration 0002 replaces its tables.
 * Task and command records keep their legacy fields, including requests and request hashes; the converted
 * task record gains its review key.
 */
export const convertLegacyState = Effect.fn('LegacyMigration.convert')(function* (
	plan: LegacyMigrationPlan,
	workers: ReadonlyArray<Worker>,
) {
	const snapshot = yield* readLegacySnapshot()
	if (snapshot.digest !== plan.snapshot)
		return yield* refuse(
			'snapshot_mismatch',
			`The database snapshot is ${snapshot.digest}, not the reviewed ${plan.snapshot}`,
		)
	const mismatch = planProblem(snapshot, plan)
	if (mismatch !== undefined) return yield* refuse('plan_mismatch', mismatch)
	if (snapshot.leases.length > 0)
		return yield* refuse('lease_held', `${snapshot.leases.length} worker leases are held`)
	const outstanding = snapshot.commands.find(
		(row) => row.delivery === 'Pending' || row.delivery === 'Unconfirmed',
	)
	if (outstanding !== undefined)
		return yield* refuse(
			'delivery_outstanding',
			`Command ${outstanding.id} delivery is ${outstanding.delivery}`,
		)
	const references = referenceProblem(snapshot)
	if (references !== undefined) return yield* refuse('inconsistent_row', references)

	const tasks = []
	const commands = []
	for (const row of snapshot.tasks) {
		const review = plan.reviews.find((review) => review.taskId === row.id)
		if (review === undefined) return yield* refuse('plan_mismatch', `Task ${row.id} is unmapped`)
		const converted = yield* convertTask(row, review, workers)
		const chain = snapshot.commands.filter((command) => command.task_id === row.id)
		tasks.push(converted)
		commands.push(...(yield* convertCommands(row.id, chain, converted.assignment)))
	}
	return { tasks, commands, snapshot: { digest: snapshot.digest, canonical: snapshot.canonical } }
})
export type LegacyConversion = Effect.Success<ReturnType<typeof convertLegacyState>>
