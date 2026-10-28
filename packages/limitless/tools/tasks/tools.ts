import { randomUUID } from 'node:crypto'
import type { ToolEditor } from '@opencode/plugin/effect/tool'
import { Effect } from 'effect'
import { ToolExecutionContext } from '../../core/execution'
import { defineLimitlessTool, type ToolExecutor } from '../../plugin/tool-boundary'
import { createTask, listTasks, reportTask, reviewTask } from './board'
import type { TaskBoardConfig } from './config'
import { encodeTaskBoardError } from './errors'
import type { OpenBoard } from './gateway'
import { type ReadSession, resolveLead, resolveUnit } from './identity'
import {
	TaskCreateInput,
	TaskCreateResult,
	TaskListInput,
	TaskListResult,
	TaskReportInput,
	TaskReportResult,
	TaskReviewInput,
	TaskReviewResult,
} from './schema'

export type TaskBoardDependencies = {
	readonly openBoard: OpenBoard
	readonly readSession: ReadSession
	readonly newTaskId?: () => string
}

const encodeLeadError = encodeTaskBoardError(
	'The board is advisory: native Unit dispatch, returns, and review continue without it.',
)
const encodeUnitError = encodeTaskBoardError(
	'The board is advisory: finish normally and include your report in your final response to the Lead.',
)

export function taskBoardTools(
	executeTool: ToolExecutor,
	config: TaskBoardConfig,
	dependencies: TaskBoardDependencies,
) {
	const { openBoard, readSession, newTaskId = randomUUID } = dependencies
	return {
		task_create: defineLimitlessTool({
			name: 'task_create',
			description:
				'Lead only. Create a Linear task board card for one approved Unit assignment before dispatching it. Returns the taskId to include in the Unit brief.',
			input: TaskCreateInput,
			output: TaskCreateResult,
			execute: (args, context) =>
				executeTool(
					'task_create',
					args,
					context,
					(input) =>
						Effect.gen(function* () {
							const lead = yield* resolveLead(yield* ToolExecutionContext)
							const board = yield* openBoard(config)
							return yield* createTask(board, config, lead, input, newTaskId())
						}),
					encodeLeadError,
				),
		}),
		task_list: defineLimitlessTool({
			name: 'task_list',
			description:
				"Lead only. List this Lead session's task board cards with status, blocked flag, latest Unit report, Unit session, and worktree. Optionally filter by status.",
			input: TaskListInput,
			output: TaskListResult,
			execute: (args, context) =>
				executeTool(
					'task_list',
					args,
					context,
					(input) =>
						Effect.gen(function* () {
							const lead = yield* resolveLead(yield* ToolExecutionContext)
							const board = yield* openBoard(config)
							return yield* listTasks(board, config, lead, input)
						}),
					encodeLeadError,
				),
		}),
		task_review: defineLimitlessTool({
			name: 'task_review',
			description:
				'Lead only. Record a decision on one of your task cards: accept (done), continue (back to in progress for corrections to the same Unit), or cancel.',
			input: TaskReviewInput,
			output: TaskReviewResult,
			execute: (args, context) =>
				executeTool(
					'task_review',
					args,
					context,
					(input) =>
						Effect.gen(function* () {
							const lead = yield* resolveLead(yield* ToolExecutionContext)
							const board = yield* openBoard(config)
							return yield* reviewTask(board, config, lead, input)
						}),
					encodeLeadError,
				),
		}),
		task_report: defineLimitlessTool({
			name: 'task_report',
			description:
				'Unit only. Report on the task card named in your brief before your final response: ready once the work is implemented, validated, and reviewed, or blocked when you need a Lead decision. Moves the card to in review.',
			input: TaskReportInput,
			output: TaskReportResult,
			execute: (args, context) =>
				executeTool(
					'task_report',
					args,
					context,
					(input) =>
						Effect.gen(function* () {
							const unit = yield* resolveUnit(yield* ToolExecutionContext, readSession)
							const board = yield* openBoard(config)
							return yield* reportTask(board, config, unit, input)
						}),
					encodeUnitError,
				),
		}),
	}
}

export function registerTaskBoardTools(
	draft: Pick<ToolEditor, 'add'>,
	tools: ReturnType<typeof taskBoardTools>,
): void {
	draft.add(tools.task_create)
	draft.add(tools.task_list)
	draft.add(tools.task_review)
	draft.add(tools.task_report)
}
