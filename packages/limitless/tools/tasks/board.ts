import { Clock, Effect, Schema, Semaphore } from 'effect'
import { optionalField } from '../../lib/type-utils'
import {
	assignmentText,
	type CardDocument,
	CardMetadata,
	newCardMetadata,
	ownerMarker,
	parseCardDescription,
	renderCardDescription,
} from './card'
import type { TaskBoardConfig } from './config'
import { type TaskBoardError, taskBoardError } from './errors'
import type { BoardGateway, BoardIssue } from './gateway'
import type { LeadCaller, UnitCaller } from './identity'
import {
	type CardStatus,
	TASK_STATUSES,
	type TaskCard,
	type TaskCreateInput,
	type TaskCreateResult,
	type TaskListInput,
	type TaskListResult,
	type TaskReportInput,
	type TaskReportResult,
	type TaskReviewInput,
	type TaskReviewResult,
	type TaskStatus,
	type UnreadableTask,
} from './schema'

// Linear's workflow state is the card's status; the managed metadata holds
// ownership, the claimed Unit, and the latest report and review. Linear has no
// compare-and-set, so writes from this process are serialized per card and
// verified by reading the card back. That does not make updates atomic across
// hosts or against manual edits; a detected interleaving is reported instead.

const ASSIGNMENT_PREVIEW_LENGTH = 500

type Card = {
	readonly issue: BoardIssue
	readonly status: CardStatus
	readonly document: CardDocument
}

type Change = { readonly status: TaskStatus; readonly metadata: CardMetadata }

const issueLocksKey: unique symbol = Symbol.for('limitless.task-board.issue-locks.v1')
const processState: typeof globalThis & {
	[issueLocksKey]?: Map<string, Semaphore.Semaphore>
} = globalThis
// Shared by every plugin location in this process, so cooperating writes to
// one card queue behind each other wherever they originate.
const issueLocks = processState[issueLocksKey] ?? new Map<string, Semaphore.Semaphore>()
processState[issueLocksKey] = issueLocks

function withIssueLock<A, E, R>(taskId: string, effect: Effect.Effect<A, E, R>) {
	return Effect.suspend(() => {
		let lock = issueLocks.get(taskId)
		if (lock === undefined) {
			lock = Semaphore.makeUnsafe(1)
			issueLocks.set(taskId, lock)
		}
		return lock.withPermit(effect)
	})
}

const sameMetadata = Schema.toEquivalence(CardMetadata)

const timestamp = Clock.currentTimeMillis.pipe(
	Effect.map((millis) => new Date(millis).toISOString()),
)

export function cardStatus(config: TaskBoardConfig, stateId: string | undefined): CardStatus {
	return TASK_STATUSES.find((status) => config.states[status] === stateId) ?? 'unsupported'
}

function onBoard(config: TaskBoardConfig, issue: BoardIssue): boolean {
	return issue.teamId === config.teamId && issue.projectId === config.projectId
}

const loadCard = Effect.fn('loadCard')(function* (
	config: TaskBoardConfig,
	taskId: string,
	issue: BoardIssue | undefined,
) {
	if (issue === undefined)
		return yield* taskBoardError('TASK_NOT_FOUND', `Task ${taskId} was not found in Linear.`, {
			taskId,
		})
	if (!onBoard(config, issue))
		return yield* taskBoardError(
			'TASK_OUTSIDE_BOARD',
			`Task ${taskId} has moved outside the configured Linear team or project.`,
			{ taskId },
		)
	const parsed = parseCardDescription(issue.description, issue.id)
	if (!parsed.ok)
		return yield* taskBoardError('MALFORMED_TASK', `Task ${taskId}: ${parsed.problem}`, { taskId })
	return {
		issue,
		status: cardStatus(config, issue.stateId),
		document: parsed.document,
	} satisfies Card
})

/**
 * Renders a card and confirms it parses back to exactly this metadata. Text
 * outside the managed section, including escaped JSON, cannot add a block.
 */
const renderCard = Effect.fn('renderCard')(function* (taskId: string, document: CardDocument) {
	const description = renderCardDescription(document)
	const parsed = parseCardDescription(description, taskId)
	if (!parsed.ok || !sameMetadata(parsed.document.metadata, document.metadata))
		return yield* taskBoardError(
			'INVALID_INPUT',
			`Task ${taskId}: the card text contains something that reads as task board metadata; rephrase it.`,
			{ taskId },
		)
	return description
})

/** Why a card read back after a write differs from what was written, if it does. */
function writtenMismatch(
	config: TaskBoardConfig,
	issue: BoardIssue | undefined,
	expected: Change,
): string | undefined {
	if (issue === undefined) return 'it is no longer visible in Linear'
	if (!onBoard(config, issue)) return 'it has moved outside the configured team or project'
	if (issue.archived) return 'it has been archived'
	if (cardStatus(config, issue.stateId) !== expected.status)
		return 'its workflow state differs from the one written'
	const parsed = parseCardDescription(issue.description, issue.id)
	if (!parsed.ok) return parsed.problem
	if (!sameMetadata(parsed.document.metadata, expected.metadata))
		return 'its metadata differs from what was written'
	return undefined
}

function unsupportedState(taskId: string, status: CardStatus): TaskBoardError | undefined {
	if (status === 'unsupported')
		return taskBoardError(
			'UNSUPPORTED_STATE',
			`Task ${taskId} is in a Linear workflow state outside the configured board states.`,
			{ taskId },
		)
	return undefined
}

/**
 * Applies one serialized read-decide-write to a card. `decide` returns the
 * change to write, or `undefined` when the card already reflects the request.
 */
const mutateTask = (
	gateway: BoardGateway,
	config: TaskBoardConfig,
	taskId: string,
	decide: (card: Card) => Effect.Effect<Change | undefined, TaskBoardError>,
) =>
	withIssueLock(
		taskId,
		Effect.gen(function* () {
			const [, issue] = yield* Effect.all([gateway.verifyBoard(), gateway.readIssue(taskId)], {
				concurrency: 'unbounded',
			})
			const card = yield* loadCard(config, taskId, issue)
			const change = yield* decide(card)
			if (change === undefined) return card.status as TaskStatus
			const description = yield* renderCard(taskId, {
				...card.document,
				metadata: change.metadata,
			})
			yield* gateway.updateIssue(taskId, { stateId: config.states[change.status], description })
			// Linear confirmed the write. A failed read here leaves only the
			// interleaving check undone, so it does not turn success into failure.
			const written = yield* gateway.readIssue(taskId).pipe(Effect.option)
			const mismatch =
				written._tag === 'Some' ? writtenMismatch(config, written.value, change) : undefined
			if (mismatch !== undefined)
				return yield* taskBoardError(
					'CONCURRENT_CHANGE',
					`Task ${taskId} changed while this update was applied (${mismatch}); run task_list to see its current state.`,
					{ taskId },
				)
			return change.status
		}),
	)

export const createTask = Effect.fn('createTask')(function* (
	gateway: BoardGateway,
	config: TaskBoardConfig,
	lead: LeadCaller,
	input: TaskCreateInput,
	taskId: string,
) {
	const change = {
		status: 'in_progress',
		metadata: newCardMetadata(taskId, lead.sessionID),
	} satisfies Change
	const description = yield* renderCard(taskId, {
		before: input.summary,
		after: '',
		metadata: change.metadata,
	})
	yield* gateway.verifyBoard()
	yield* gateway.createIssue({
		id: taskId,
		title: input.title,
		stateId: config.states.in_progress,
		description,
	})
	const created = yield* gateway.readIssue(taskId).pipe(Effect.option)
	if (created._tag === 'None' || created.value === undefined)
		return yield* taskBoardError(
			'READBACK_FAILED',
			`Created task ${taskId}, but could not read its link back from Linear. Use this taskId; do not create another card.`,
			{ taskId },
		)
	const mismatch = writtenMismatch(config, created.value, change)
	if (mismatch !== undefined)
		return yield* taskBoardError(
			'MALFORMED_TASK',
			`Created task ${taskId} at ${created.value.url}, but Linear does not show the card as written (${mismatch}). Inspect it before relying on the board; do not create another card.`,
			{ taskId },
		)
	return { taskId, url: created.value.url, status: 'in_progress' } satisfies TaskCreateResult
})

function taskCard(card: Card): TaskCard {
	const { metadata } = card.document
	const assignment = assignmentText(card.document)
	return {
		taskId: card.issue.id,
		identifier: card.issue.identifier,
		title: card.issue.title,
		url: card.issue.url,
		status: card.status,
		blocked: metadata.blocked && card.status === 'in_review',
		archived: card.issue.archived,
		updatedAt: card.issue.updatedAt,
		assignment:
			assignment.length > ASSIGNMENT_PREVIEW_LENGTH
				? `${assignment.slice(0, ASSIGNMENT_PREVIEW_LENGTH)}…`
				: assignment,
		...optionalField('report', metadata.report ?? undefined),
		...optionalField('review', metadata.review ?? undefined),
		...optionalField('unitSessionID', metadata.unit?.sessionID),
		...optionalField('worktree', metadata.unit?.worktree),
	}
}

export const listTasks = Effect.fn('listTasks')(function* (
	gateway: BoardGateway,
	config: TaskBoardConfig,
	lead: LeadCaller,
	input: TaskListInput,
) {
	const issues = yield* gateway.listIssues({
		ownerMarker: ownerMarker(lead.sessionID),
		...optionalField('stateId', input.status && config.states[input.status]),
	})
	const tasks: Array<TaskCard> = []
	const unreadable: Array<UnreadableTask> = []
	for (const issue of issues) {
		// The description search is only a candidate filter; ownership comes
		// from each card's validated metadata.
		if (!onBoard(config, issue)) continue
		const parsed = parseCardDescription(issue.description, issue.id)
		if (!parsed.ok) {
			unreadable.push({ identifier: issue.identifier, url: issue.url, problem: parsed.problem })
			continue
		}
		if (parsed.document.metadata.lead.sessionID !== lead.sessionID) continue
		const card = { issue, status: cardStatus(config, issue.stateId), document: parsed.document }
		if (input.status !== undefined && card.status !== input.status) continue
		tasks.push(taskCard(card))
	}
	tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
	return { tasks, unreadable } satisfies TaskListResult
})

const reviewChange = Effect.fn('reviewChange')(function* (
	card: Card,
	input: TaskReviewInput,
	reviewedAt: string,
) {
	const taskId = card.issue.id
	const { metadata } = card.document
	const unsupported = unsupportedState(taskId, card.status)
	if (unsupported !== undefined) return yield* unsupported
	const review = { decision: input.decision, ...optionalField('note', input.note), reviewedAt }
	switch (input.decision) {
		case 'accept':
			if (card.status === 'done') return undefined
			if (card.status === 'canceled')
				return yield* taskBoardError(
					'TASK_CLOSED',
					`Task ${taskId} is canceled; canceled cards stay closed.`,
					{ taskId },
				)
			return { status: 'done', metadata: { ...metadata, blocked: false, review } } satisfies Change
		case 'cancel':
			if (card.status === 'canceled') return undefined
			if (card.status === 'done')
				return yield* taskBoardError(
					'TASK_CLOSED',
					`Task ${taskId} is done; use continue to reopen it for corrections.`,
					{ taskId },
				)
			return {
				status: 'canceled',
				metadata: { ...metadata, blocked: false, review },
			} satisfies Change
		case 'continue': {
			if (card.status === 'canceled')
				return yield* taskBoardError(
					'TASK_CLOSED',
					`Task ${taskId} is canceled; canceled cards stay closed. Create a new card for new work.`,
					{ taskId },
				)
			const report = metadata.report === null ? null : { ...metadata.report, superseded: true }
			const repeated =
				card.status === 'in_progress' &&
				!metadata.blocked &&
				(metadata.report === null || metadata.report.superseded) &&
				metadata.review?.decision === 'continue' &&
				(input.note === undefined || input.note === metadata.review.note)
			if (repeated) return undefined
			return {
				status: 'in_progress',
				metadata: { ...metadata, blocked: false, report, review },
			} satisfies Change
		}
	}
})

export const reviewTask = Effect.fn('reviewTask')(function* (
	gateway: BoardGateway,
	config: TaskBoardConfig,
	lead: LeadCaller,
	input: TaskReviewInput,
) {
	const status = yield* mutateTask(gateway, config, input.taskId, (card) =>
		Effect.gen(function* () {
			if (card.document.metadata.lead.sessionID !== lead.sessionID)
				return yield* taskBoardError(
					'NOT_TASK_OWNER',
					`Task ${input.taskId} belongs to another Lead session.`,
					{ taskId: input.taskId },
				)
			if (card.issue.archived)
				return yield* taskBoardError(
					'TASK_ARCHIVED',
					`Task ${input.taskId} is archived in Linear; restore it there to change it.`,
					{ taskId: input.taskId },
				)
			return yield* reviewChange(card, input, yield* timestamp)
		}),
	)
	return { taskId: input.taskId, status } satisfies TaskReviewResult
})

export const reportTask = Effect.fn('reportTask')(function* (
	gateway: BoardGateway,
	config: TaskBoardConfig,
	unit: UnitCaller,
	input: TaskReportInput,
) {
	const blocked = input.result === 'blocked'
	yield* mutateTask(gateway, config, input.taskId, (card) =>
		Effect.gen(function* () {
			const taskId = input.taskId
			const { metadata } = card.document
			if (metadata.lead.sessionID !== unit.parentID)
				return yield* taskBoardError(
					'WRONG_LEAD',
					`Task ${taskId} belongs to a different Lead session than this Unit's.`,
					{ taskId },
				)
			if (metadata.unit !== null && metadata.unit.sessionID !== unit.sessionID)
				return yield* taskBoardError(
					'ASSIGNED_TO_OTHER_UNIT',
					`Task ${taskId} is already assigned to another Unit session.`,
					{ taskId },
				)
			if (card.issue.archived)
				return yield* taskBoardError('TASK_ARCHIVED', `Task ${taskId} is archived in Linear.`, {
					taskId,
				})
			if (card.status === 'done' || card.status === 'canceled')
				return yield* taskBoardError(
					'TASK_CLOSED',
					`Task ${taskId} is ${card.status === 'done' ? 'done' : 'canceled'}; the Lead has closed it.`,
					{ taskId },
				)
			const unsupported = unsupportedState(taskId, card.status)
			if (unsupported !== undefined) return yield* unsupported
			return {
				status: 'in_review',
				metadata: {
					...metadata,
					unit: { sessionID: unit.sessionID, worktree: unit.worktree, directory: unit.directory },
					blocked,
					report: {
						result: input.result,
						summary: input.summary,
						reportedAt: yield* timestamp,
						superseded: false,
					},
				},
			} satisfies Change
		}),
	)
	return { taskId: input.taskId, status: 'in_review', blocked } satisfies TaskReportResult
})
