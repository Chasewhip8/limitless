import { Schema } from 'effect'
import { NativeObservation, NativeReference } from '../worker/schema'

export const TaskId = Schema.String.check(
	Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
)
export const CommandId = TaskId
export const Repository = Schema.String.check(
	Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/),
)
export const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))

export const ReviewRequest = Schema.Struct({
	kind: Schema.Literal('review'),
	pr: Schema.String.check(
		Schema.isPattern(
			/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/pull\/[1-9][0-9]*\/?$/,
		),
	),
	system: Schema.optionalKey(Schema.Literals(['x86_64-linux', 'aarch64-linux'])),
}).annotate({
	description:
		'Dispatch a PR review into a retained checkout and native OpenCode session. OpenCode owns execution, input, history and results.',
})
export type ReviewRequest = typeof ReviewRequest.Type

export const ResumeRequest = Schema.Struct({
	afterCommandId: CommandId,
	message: Schema.NonEmptyString.check(Schema.isMaxLength(100_000)),
}).annotate({
	description:
		'Send a new message to the existing native session. The anchor identifies caller intent and must belong to this task; it is not an execution or result prerequisite.',
})
export type ResumeRequest = typeof ResumeRequest.Type

export const InterruptRequest = Schema.Struct({ afterCommandId: CommandId }).annotate({
	description:
		'Request a native interrupt, including on closed tasks. Acknowledgment is not proof that execution or OS writers have stopped.',
})
export type InterruptRequest = typeof InterruptRequest.Type

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
	workspaceRoot: Schema.String,
	helperExecutable: Schema.String,
	directory: Schema.String,
	sessionId: Schema.String,
})
export type Assignment = typeof Assignment.Type

export const Task = Schema.Struct({
	id: TaskId,
	createdAt: Schema.Number,
	request: ReviewRequest,
	submissions: Schema.Union([Schema.TaggedStruct('Open', {}), Schema.TaggedStruct('Closed', {})]),
	placement: Schema.Union([
		Schema.TaggedStruct('Unassigned', {}),
		Schema.TaggedStruct('Assigned', { assignment: Assignment }),
	]),
}).annotate({
	description:
		'A routing and query index, not an execution record. Closing disables new message commands and cancels unsent messages; checkout and native history are retained indefinitely.',
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

const PendingStep = Schema.Literals(['checkout', 'session', 'send'])

export const Delivery = Schema.Union([
	Schema.TaggedStruct('Pending', { step: PendingStep }),
	Schema.TaggedStruct('Unconfirmed', {}),
	Schema.TaggedStruct('Acknowledged', { nativeRef: NativeReference }),
	Schema.TaggedStruct('CancelledBeforeSend', {}),
	Schema.TaggedStruct('Rejected', { reason: Rejection }),
]).annotate({
	description:
		'Delivery only, never execution status. Unconfirmed means a request may have been sent; missing native evidence or idle cannot clear it or authorize replay. Positive exact acknowledgment is required.',
})
export type Delivery = typeof Delivery.Type

const commandFields = {
	id: CommandId,
	taskId: TaskId,
	createdAt: Schema.Number,
	version: Schema.Int,
	kind: Schema.Literals(['review', 'resume', 'interrupt']),
	afterCommandId: Schema.optionalKey(CommandId),
	messageId: Schema.optionalKey(Schema.String),
	requestHash: Schema.String,
}
export const CommandReceipt = Schema.Struct({ ...commandFields, delivery: Delivery })
export type CommandReceipt = typeof CommandReceipt.Type

export const DispatchReceipt = Schema.Struct({ task: Task, command: CommandReceipt })
export type DispatchReceipt = typeof DispatchReceipt.Type

export const CommandView = Schema.Struct({
	task: Task,
	command: CommandReceipt,
	observation: NativeObservation,
})
export type CommandView = typeof CommandView.Type

export const TaskView = Schema.Struct({
	task: Task,
	commands: Schema.Array(CommandReceipt),
	observation: NativeObservation,
})
export type TaskView = typeof TaskView.Type

export const Payload = Schema.Union([
	Schema.TaggedStruct('Review', { pr: PullRequest, prompt: Schema.String }),
	Schema.TaggedStruct('Resume', { prompt: Schema.String }),
	Schema.TaggedStruct('Interrupt', {}),
])
export type Payload = typeof Payload.Type

export const StoredCommand = Schema.Struct({
	...commandFields,
	delivery: Schema.Union([
		Schema.TaggedStruct('Pending', { step: PendingStep, payload: Payload }),
		Schema.TaggedStruct('Unconfirmed', { payload: Payload }),
		Schema.TaggedStruct('Acknowledged', { nativeRef: NativeReference }),
		Schema.TaggedStruct('CancelledBeforeSend', {}),
		Schema.TaggedStruct('Rejected', { reason: Rejection }),
	]),
})
export type StoredCommand = typeof StoredCommand.Type

export const CommandEvent = Schema.Union([
	Schema.TaggedStruct('CheckoutPrepared', {}),
	Schema.TaggedStruct('SessionPrepared', {}),
	Schema.TaggedStruct('DeliveryStarted', {}),
	Schema.TaggedStruct('Acknowledged', { nativeRef: NativeReference }),
	Schema.TaggedStruct('CancelledBeforeSend', {}),
	Schema.TaggedStruct('Rejected', { reason: Rejection }),
])
export type CommandEvent = typeof CommandEvent.Type

export class InvalidTransition extends Schema.TaggedError<InvalidTransition>()(
	'InvalidTransition',
	{ commandId: Schema.String, event: Schema.String, state: Schema.String },
) {}
export class TaskNotFound extends Schema.TaggedError<TaskNotFound>()('TaskNotFound', {
	id: Schema.String,
}) {}
export class CommandNotFound extends Schema.TaggedError<CommandNotFound>()('CommandNotFound', {
	taskId: Schema.String,
	commandId: Schema.String,
}) {}
export class TaskConflict extends Schema.TaggedError<TaskConflict>()(
	'TaskConflict',
	{
		code: Schema.Literals([
			'idempotency_conflict',
			'version_conflict',
			'capacity_conflict',
			'delivery_unconfirmed',
			'task_closed',
			'placement_conflict',
		]),
	},
	{
		description:
			'Intent mismatch, changed delivery version, exhausted advisory capacity, unresolved possible delivery, closed submissions, or incompatible pinned placement.',
	},
) {}
