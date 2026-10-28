import { Tool } from '@opencode/schema/tool'
import { Schema } from 'effect'
import { optionalField } from '../../lib/type-utils'

export const TaskBoardErrorCode = Schema.Literals([
	// The caller's role, ownership, or assignment does not permit the request.
	'ROLE_NOT_ALLOWED',
	'NOT_TASK_OWNER',
	'WRONG_LEAD',
	'UNIT_NOT_PLACED',
	'ASSIGNED_TO_OTHER_UNIT',
	'SESSION_UNAVAILABLE',
	// The card cannot accept the request in its current state.
	'TASK_NOT_FOUND',
	'TASK_OUTSIDE_BOARD',
	'TASK_ARCHIVED',
	'TASK_CLOSED',
	'UNSUPPORTED_STATE',
	'MALFORMED_TASK',
	'INVALID_INPUT',
	// The configured board or credentials are unusable.
	'BOARD_MISCONFIGURED',
	'TOKEN_MISSING',
	'TOKEN_UNREADABLE',
	'AUTHENTICATION_FAILED',
	'ACCESS_DENIED',
	// Linear rejected, throttled, or did not answer the request.
	'RATE_LIMITED',
	'REJECTED',
	'UNAVAILABLE',
	'TIMEOUT',
	'OUTCOME_UNKNOWN',
	'READBACK_FAILED',
	'CONCURRENT_CHANGE',
	'TOO_MANY_TASKS',
])
export type TaskBoardErrorCode = typeof TaskBoardErrorCode.Type

/**
 * The only failure type task tools surface. It carries allowlisted fields and
 * never an underlying cause: Linear SDK errors embed request variables, raw
 * responses, and headers, so they are mapped here and then discarded.
 */
export class TaskBoardError extends Schema.TaggedError<TaskBoardError>()('TaskBoardError', {
	code: TaskBoardErrorCode,
	message: Schema.String,
	taskId: Schema.optional(Schema.String),
	outcomeUnknown: Schema.optional(Schema.Boolean),
	retryAfterSeconds: Schema.optional(Schema.Number),
	httpStatus: Schema.optional(Schema.Number),
}) {}

export function taskBoardError(
	code: TaskBoardErrorCode,
	message: string,
	details: {
		readonly taskId?: string | undefined
		readonly outcomeUnknown?: boolean | undefined
		readonly retryAfterSeconds?: number | undefined
		readonly httpStatus?: number | undefined
	} = {},
): TaskBoardError {
	return new TaskBoardError({
		code,
		message,
		...optionalField('taskId', details.taskId),
		...optionalField('outcomeUnknown', details.outcomeUnknown),
		...optionalField('retryAfterSeconds', details.retryAfterSeconds),
		...optionalField('httpStatus', details.httpStatus),
	})
}

/** Encodes a task board failure with an advisory hint for the calling role. */
export function encodeTaskBoardError(hint: string) {
	return (error: TaskBoardError): Tool.Error =>
		new Tool.Error({
			message: `${error.message} ${hint}`,
			metadata: {
				ok: false,
				error: error._tag,
				code: error.code,
				...optionalField('taskId', error.taskId),
				...optionalField('outcomeUnknown', error.outcomeUnknown),
				...optionalField('retryAfterSeconds', error.retryAfterSeconds),
				...optionalField('httpStatus', error.httpStatus),
			},
		})
}
