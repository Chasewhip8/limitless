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
import { CommandNotFound, OperationNotFound, TaskConflict, TaskNotFound } from './tasks/schema'
import {
	InterruptReceipt,
	OperationId,
	OperationReceipt,
	OperationView,
	ReviewInput,
} from './workflow'

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
	'Unauthorized',
	{},
	{ httpApiStatus: 401 },
) {}
export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
	'pipeline/api/Authorization',
	{ security: { bearer: HttpApiSecurity.bearer }, error: Unauthorized },
) {}
const params = { operation: OperationId }
const missing = [OperationNotFound, TaskNotFound, CommandNotFound].map((schema) =>
	schema.pipe(HttpApiSchema.status(404)),
)
const conflict = TaskConflict.pipe(HttpApiSchema.status(409))
const unavailable = PullRequestUnavailable.pipe(HttpApiSchema.status(422))
const accepted = OperationReceipt.pipe(HttpApiSchema.status(202))

export class PipelineApi extends HttpApi.make('pipeline').add(
	HttpApiGroup.make('reviews')
		.add(
			HttpApiEndpoint.post('review', '/reviews', {
				payload: ReviewInput,
				success: accepted,
				error: [conflict, unavailable, ...missing],
			}).annotate(
				OpenApi.Description,
				'Start or recover the current retained review across callers. Closed reviews remain current until explicitly restarted.',
			),
			HttpApiEndpoint.post('continue', '/operations/:operation/continue', {
				params,
				success: accepted,
				error: [conflict, ...missing],
			}).annotate(
				OpenApi.Description,
				'Continue with the fixed review prompt after settled execution. Repeating the same anchor returns its accepted successor, even after later progress.',
			),
			HttpApiEndpoint.post('restart', '/operations/:operation/restart', {
				params,
				success: accepted,
				error: [conflict, unavailable, ...missing],
			}).annotate(
				OpenApi.Description,
				'Explicitly create an independent review after settled work. Retains the predecessor checkout and session; never interrupts live work. Repeating the anchor recovers the same successor.',
			),
			HttpApiEndpoint.post('interrupt', '/operations/:operation/interrupt', {
				params,
				success: InterruptReceipt.pipe(HttpApiSchema.status(202)),
				error: [conflict, ...missing],
			}).annotate(
				OpenApi.Description,
				'Request interruption of the current review operation, also when closed. Repeating the anchor recovers the request. Acknowledgment is not proof execution stopped.',
			),
			HttpApiEndpoint.get('get', '/operations/:operation', {
				params,
				success: OperationView,
				error: missing,
			}),
			HttpApiEndpoint.get('events', '/operations/:operation/events', {
				params,
				success: HttpApiSchema.StreamNdjson({ schema: OperationView }),
				error: missing,
			}).annotate(
				OpenApi.Description,
				'NDJSON views until this operation has a native result, needs input, or is unavailable. Blank-line heartbeats every 15 seconds. Disconnecting only releases the subscription.',
			),
			HttpApiEndpoint.get('health', '/health', {
				success: Schema.Struct({ status: Schema.Literal('ok') }),
			}),
		)
		.middleware(Authorization),
) {}
