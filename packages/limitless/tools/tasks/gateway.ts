import type { Effect } from 'effect'
import type { TaskBoardConfig } from './config'
import type { TaskBoardError } from './errors'

/** The issue fields the board reads, independent of the Linear SDK models. */
export type BoardIssue = {
	readonly id: string
	readonly identifier: string
	readonly title: string
	readonly url: string
	readonly description: string
	readonly teamId: string | undefined
	readonly projectId: string | undefined
	readonly stateId: string | undefined
	readonly updatedAt: string
	readonly archived: boolean
}

export type IssueQuery = {
	readonly ownerMarker: string
	readonly stateId?: string
}

/**
 * The Linear operations behind the task tools. Each call is one bounded,
 * non-retried request sequence; mutations fail with `outcomeUnknown` when
 * Linear may have applied them without confirming.
 */
export interface BoardGateway {
	/** Confirms the configured team, project, and workflow states before writes. */
	readonly verifyBoard: () => Effect.Effect<void, TaskBoardError>
	readonly readIssue: (id: string) => Effect.Effect<BoardIssue | undefined, TaskBoardError>
	readonly listIssues: (
		query: IssueQuery,
	) => Effect.Effect<ReadonlyArray<BoardIssue>, TaskBoardError>
	readonly createIssue: (input: {
		readonly id: string
		readonly title: string
		readonly description: string
		readonly stateId: string
	}) => Effect.Effect<void, TaskBoardError>
	readonly updateIssue: (
		id: string,
		input: { readonly stateId: string; readonly description: string },
	) => Effect.Effect<void, TaskBoardError>
}

/** Opens the board for one tool call, reading credentials lazily. */
export type OpenBoard = (config: TaskBoardConfig) => Effect.Effect<BoardGateway, TaskBoardError>
