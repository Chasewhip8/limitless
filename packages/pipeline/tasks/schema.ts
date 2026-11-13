import { Schema } from 'effect'
import { ReviewInput } from '../workflow'

export const TaskId = Schema.String.check(
	Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
)
export const CommandId = TaskId
export const Repository = Schema.String.check(
	Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/),
)
export const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))

export const ReviewRequest = ReviewInput
export type ReviewRequest = ReviewInput

export const PullRequest = Schema.Struct({
	url: Schema.String,
	repository: Repository,
	sourceRepository: Repository,
	repositoryId: Schema.Int,
	sourceRepositoryId: Schema.Int,
	number: Schema.Int,
	headRef: Schema.NonEmptyString,
	headSha: Commit,
	baseSha: Commit,
})
export type PullRequest = typeof PullRequest.Type

export const Assignment = Schema.Struct({
	workerId: Schema.String,
	workerUrl: Schema.String,
	controlDirectory: Schema.String,
	storageId: Schema.String,
	workspaceId: Schema.String,
	sessionId: Schema.String,
	directory: Schema.String.annotate({
		description: 'Checkout directory observed from the Capsule host at assignment.',
	}),
}).annotate({
	description:
		'Pinned worker and Capsule host placement. The host owns the checkout and runtime; it refuses a changed storage identity instead of moving the session.',
})
export type Assignment = typeof Assignment.Type

export const ReviewKey = Schema.String.check(Schema.isPattern(/^[0-9]+:[1-9][0-9]*$/)).annotate({
	description:
		'Stable GitHub pull request identity, `repositoryId:number`, that survives repository renames.',
})

export const pullRequestReviewKey = (repositoryId: number, number: number) =>
	`${repositoryId}:${number}`

export const Task = Schema.Struct({
	id: TaskId,
	createdAt: Schema.Number,
	request: ReviewRequest,
	reviewKey: ReviewKey,
	submissions: Schema.Union([Schema.TaggedStruct('Open', {}), Schema.TaggedStruct('Closed', {})]),
	placement: Schema.Union([
		Schema.TaggedStruct('Unassigned', {}),
		Schema.TaggedStruct('Assigned', { assignment: Assignment }),
	]),
}).annotate({
	description:
		'A routing and query index, not an execution record. Each review key maps to one current task; a restart closes it and maps its successor. Closing disables new message commands and cancels unsent messages; checkout and native history are retained indefinitely.',
})
export type Task = typeof Task.Type

export const Rejection = Schema.Struct({
	code: Schema.Literals([
		'queue_timeout',
		'preparation_failed',
		'session_unavailable',
		'worker_incompatible',
	]),
	message: Schema.String,
})
export type Rejection = typeof Rejection.Type

export class TaskNotFound extends Schema.TaggedError<TaskNotFound>()('TaskNotFound', {
	id: Schema.String,
}) {}
export class CommandNotFound extends Schema.TaggedError<CommandNotFound>()('CommandNotFound', {
	taskId: Schema.String,
	commandId: Schema.String,
}) {}
export class OperationNotFound extends Schema.TaggedError<OperationNotFound>()(
	'OperationNotFound',
	{ operation: Schema.String },
) {}
export class TaskConflict extends Schema.TaggedError<TaskConflict>()(
	'TaskConflict',
	{
		code: Schema.Literals([
			'version_conflict',
			'capacity_conflict',
			'delivery_unconfirmed',
			'task_closed',
			'placement_conflict',
			'stale_operation',
			'operation_pending',
			'native_unsettled',
			'observation_timeout',
			'session_unavailable',
		]),
	},
	{
		description:
			'Changed delivery version, exhausted advisory capacity, unresolved possible delivery, closed submissions, incompatible pinned placement, an anchor that is no longer the current latest operation, an unsent operation, unsettled native execution, or an unavailable native session.',
	},
) {}
