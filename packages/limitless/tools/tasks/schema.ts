import { Schema, SchemaGetter } from 'effect'
import { TrimmedString } from '../../core/command'

export const TASK_STATUSES = ['in_progress', 'in_review', 'done', 'canceled'] as const
export const TaskStatus = Schema.Literals(TASK_STATUSES)
export type TaskStatus = typeof TaskStatus.Type

/** A card whose Linear workflow state is outside the configured board states. */
export const CardStatus = Schema.Literals([...TASK_STATUSES, 'unsupported'])
export type CardStatus = typeof CardStatus.Type

export const ReportResult = Schema.Literals(['ready', 'blocked'])
export type ReportResult = typeof ReportResult.Type

export const ReviewDecision = Schema.Literals(['accept', 'continue', 'cancel'])
export type ReviewDecision = typeof ReviewDecision.Type

/** Text containing this marker could forge a card's managed block or owner marker. */
export const RESERVED_MARKER = 'limitless-task'

export const TITLE_MAX_LENGTH = 120
export const SUMMARY_MAX_LENGTH = 4_000
export const NOTE_MAX_LENGTH = 2_000

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

function boundedText(label: string, maxLength: number, options: { singleLine?: boolean } = {}) {
	return TrimmedString.check(
		Schema.makeFilter((value) => {
			if (value.length === 0) return `${label} is required`
			if (value.length > maxLength) return `${label} must be ${maxLength} characters or fewer`
			if (options.singleLine && /[\r\n]/u.test(value)) return `${label} must be a single line`
			if (value.toLowerCase().includes(RESERVED_MARKER))
				return `${label} must not contain the reserved marker "${RESERVED_MARKER}"`
			return true
		}),
	)
}

export const TaskId = TrimmedString.pipe(
	Schema.decode({
		decode: SchemaGetter.transform((value) => value.toLowerCase()),
		encode: SchemaGetter.transform((value) => value.toLowerCase()),
	}),
).check(Schema.makeFilter((value) => uuidPattern.test(value) || 'taskId must be a task board UUID'))

export const TaskCreateInput = Schema.Struct({
	title: boundedText('title', TITLE_MAX_LENGTH, { singleLine: true }),
	summary: boundedText('summary', SUMMARY_MAX_LENGTH),
})
export type TaskCreateInput = typeof TaskCreateInput.Type

export const TaskCreateResult = Schema.Struct({
	taskId: Schema.String,
	url: Schema.String,
	status: Schema.Literal('in_progress'),
})
export type TaskCreateResult = typeof TaskCreateResult.Type

export const TaskListInput = Schema.Struct({
	status: Schema.optional(TaskStatus),
})
export type TaskListInput = typeof TaskListInput.Type

export const TaskReport = Schema.Struct({
	result: ReportResult,
	summary: Schema.String,
	reportedAt: Schema.String,
	/** A Lead `continue` supersedes the report; it describes an earlier round. */
	superseded: Schema.Boolean,
})

export const TaskReview = Schema.Struct({
	decision: ReviewDecision,
	note: Schema.optional(Schema.String),
	reviewedAt: Schema.String,
})

export const TaskCard = Schema.Struct({
	taskId: Schema.String,
	identifier: Schema.String,
	title: Schema.String,
	url: Schema.String,
	status: CardStatus,
	blocked: Schema.Boolean,
	archived: Schema.Boolean,
	updatedAt: Schema.String,
	assignment: Schema.String,
	report: Schema.optional(TaskReport),
	review: Schema.optional(TaskReview),
	unitSessionID: Schema.optional(Schema.String),
	worktree: Schema.optional(Schema.String),
})
export type TaskCard = typeof TaskCard.Type

export const UnreadableTask = Schema.Struct({
	identifier: Schema.String,
	url: Schema.String,
	problem: Schema.String,
})
export type UnreadableTask = typeof UnreadableTask.Type

export const TaskListResult = Schema.Struct({
	tasks: Schema.Array(TaskCard),
	unreadable: Schema.Array(UnreadableTask),
})
export type TaskListResult = typeof TaskListResult.Type

export const TaskReviewInput = Schema.Struct({
	taskId: TaskId,
	decision: ReviewDecision,
	note: Schema.optional(boundedText('note', NOTE_MAX_LENGTH)),
})
export type TaskReviewInput = typeof TaskReviewInput.Type

export const TaskReviewResult = Schema.Struct({
	taskId: Schema.String,
	status: TaskStatus,
})
export type TaskReviewResult = typeof TaskReviewResult.Type

export const TaskReportInput = Schema.Struct({
	taskId: TaskId,
	result: ReportResult,
	summary: boundedText('summary', SUMMARY_MAX_LENGTH),
})
export type TaskReportInput = typeof TaskReportInput.Type

export const TaskReportResult = Schema.Struct({
	taskId: Schema.String,
	status: Schema.Literal('in_review'),
	blocked: Schema.Boolean,
})
export type TaskReportResult = typeof TaskReportResult.Type
