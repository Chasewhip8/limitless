import { Schema } from 'effect'
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiMiddleware,
	HttpApiSchema,
	HttpApiSecurity,
	OpenApi,
} from 'effect/http-api'
import { PullRequestUnavailable } from './github/schema'
import {
	CommandId,
	CommandNotFound,
	CommandView,
	DispatchReceipt,
	InterruptRequest,
	ResumeRequest,
	ReviewRequest,
	Task,
	TaskConflict,
	TaskId,
	TaskNotFound,
	TaskView,
} from './tasks/schema'

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
	'Unauthorized',
	{},
	{ httpApiStatus: 401 },
) {}
export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
	'pipeline/api/Authorization',
	{ security: { bearer: HttpApiSecurity.bearer }, error: Unauthorized },
) {}
const headers = {
	'idempotency-key': Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(200),
		Schema.isPattern(/^[\x21-\x7e]+$/),
	),
}
const taskParams = { id: TaskId }
const commandParams = { id: TaskId, commandId: CommandId }
const taskMissing = TaskNotFound.pipe(HttpApiSchema.status(404))
const missing = [taskMissing, CommandNotFound.pipe(HttpApiSchema.status(404))]
const conflict = TaskConflict.pipe(HttpApiSchema.status(409))
const unavailable = PullRequestUnavailable.pipe(HttpApiSchema.status(422))
const accepted = DispatchReceipt.pipe(HttpApiSchema.status(202))

export class PipelineApi extends HttpApi.make('pipeline').add(
	HttpApiGroup.make('tasks')
		.add(
			HttpApiEndpoint.post('submit', '/tasks', {
				headers,
				payload: ReviewRequest,
				success: accepted,
				error: [conflict, unavailable, ...missing],
			}).annotate(
				OpenApi.Description,
				'Create a task routed to a retained Capsule checkout and a new native OpenCode session, with its initial review message in the durable outbox. Idempotency-Key binds the intent; an identical retry returns the same receipt.',
			),
			HttpApiEndpoint.post('resume', '/tasks/:id/resume', {
				params: taskParams,
				headers,
				payload: ResumeRequest,
				success: accepted,
				error: [conflict, ...missing],
			}).annotate(
				OpenApi.Description,
				'Queue a message to the task’s existing native session. Refused while the task is closed or any delivery is Unconfirmed; never creates a replacement session.',
			),
			HttpApiEndpoint.post('interrupt', '/tasks/:id/interrupt', {
				params: taskParams,
				headers,
				payload: InterruptRequest,
				success: accepted,
				error: [conflict, ...missing],
			}).annotate(
				OpenApi.Description,
				'Queue a native interrupt, also on closed tasks. Refused while any delivery is Unconfirmed. Acknowledgment does not prove that execution or OS processes stopped.',
			),
			HttpApiEndpoint.post('close', '/tasks/:id/close', {
				params: taskParams,
				success: Task,
				error: taskMissing,
			}).annotate(
				OpenApi.Description,
				'Idempotently disable new messages and cancel unsent ones. Never interrupts, stops the Capsule, archives, or deletes; the Capsule checkout and native session are retained.',
			),
			HttpApiEndpoint.get('get', '/tasks/:id', {
				params: taskParams,
				success: TaskView,
				error: taskMissing,
			}).annotate(
				OpenApi.Description,
				'Read the task routing, its command receipts, and a live observation of the native session. Messages, history, and results remain in OpenCode.',
			),
			HttpApiEndpoint.get('getCommand', '/tasks/:id/commands/:commandId', {
				params: commandParams,
				success: CommandView,
				error: missing,
			}).annotate(OpenApi.Description, 'Read one command receipt with a live native observation.'),
			HttpApiEndpoint.get('events', '/tasks/:id/commands/:commandId/events', {
				params: commandParams,
				success: HttpApiSchema.StreamNdjson({ schema: CommandView }),
				error: missing,
			}).annotate(
				OpenApi.Description,
				'NDJSON CommandView: the current view, then each changed view, ending once delivery is final and an acknowledged command’s native observation is idle, needs input, cancelled, or unavailable. Blank-line heartbeats every 15 seconds. Disconnecting only releases the subscription.',
			),
			HttpApiEndpoint.get('health', '/health', {
				success: Schema.Struct({ status: Schema.Literal('ok') }),
			}),
		)
		.middleware(Authorization),
) {}
