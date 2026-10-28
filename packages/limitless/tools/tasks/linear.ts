import { readFile } from 'node:fs/promises'
import {
	type Issue,
	LinearClient,
	LinearDocument,
	LinearError,
	LinearErrorType,
	RatelimitedLinearError,
} from '@linear/sdk'
import { Duration, Effect, Redacted } from 'effect'
import { objectProperty } from '../../lib/guards'
import type { TaskBoardConfig } from './config'
import { type TaskBoardError, taskBoardError } from './errors'
import type { BoardGateway, BoardIssue, IssueQuery, OpenBoard } from './gateway'
import { TASK_STATUSES, type TaskStatus } from './schema'

// The Linear SDK neither retries nor times out, and its errors carry request
// variables, raw responses, and headers. Every request here is attempted once,
// bounded, aborted through its signal, and mapped to allowlisted fields before
// the original error is discarded.

export const LINEAR_REQUEST_TIMEOUT = Duration.seconds(15)
export const LINEAR_PAGE_SIZE = 50
export const LINEAR_MAX_PAGES = 20

const expectedStateTypes = {
	in_progress: 'started',
	in_review: 'started',
	done: 'completed',
	canceled: 'canceled',
} as const satisfies Record<TaskStatus, string>

// Untraced and redacted: a span would otherwise record the token as its result.
const readLinearToken = Effect.fnUntraced(function* (config: TaskBoardConfig) {
	const tokenFile = config.tokenFile
	const token =
		tokenFile === undefined
			? process.env[config.tokenEnv]?.trim()
			: (yield* Effect.tryPromise({
					try: (signal) => readFile(tokenFile, { encoding: 'utf8', signal }),
					catch: (error) => {
						const code = objectProperty(error, 'code')
						return taskBoardError(
							'TOKEN_UNREADABLE',
							`Could not read the configured Linear token file${typeof code === 'string' ? ` (${code})` : ''}.`,
						)
					},
				})).trim()
	if (token === undefined || token.length === 0)
		return yield* taskBoardError(
			'TOKEN_MISSING',
			tokenFile === undefined
				? `No Linear token is available: set ${config.tokenEnv} in the OpenCode service environment or configure linear.tokenFile.`
				: 'The configured Linear token file is empty.',
		)
	if (/[\r\n]/u.test(token))
		return yield* taskBoardError('TOKEN_UNREADABLE', 'The Linear token must be a single line.')
	return Redacted.make(token)
})

type Write = { readonly taskId: string; readonly unconfirmed: string }

type Rejection = 'RATE_LIMITED' | 'AUTHENTICATION_FAILED' | 'ACCESS_DENIED' | 'REJECTED'

/** Error types that refuse a request outright, by the code they surface as. */
function rejectionOf(type: LinearErrorType | undefined): Rejection | undefined {
	switch (type) {
		case LinearErrorType.Ratelimited:
			return 'RATE_LIMITED'
		case LinearErrorType.AuthenticationError:
			return 'AUTHENTICATION_FAILED'
		case LinearErrorType.Forbidden:
			return 'ACCESS_DENIED'
		case LinearErrorType.InvalidInput:
		case LinearErrorType.UserError:
		case LinearErrorType.FeatureNotAccessible:
		case LinearErrorType.UsageLimitExceeded:
			return 'REJECTED'
		default:
			return undefined
	}
}

/**
 * Whether Linear refused a mutation before executing it. The SDK throws on any
 * GraphQL error, even beside a result that executed, and reports only the
 * first error's type. A partial result, an error located in the response
 * (raised during execution, possibly after a write), or any error that is not
 * a refusal leaves the outcome unknown.
 */
function refusedBeforeExecution(error: LinearError): Rejection | undefined {
	const data = error.data
	if (
		typeof data === 'object' &&
		data !== null &&
		Object.values(data).some((value) => value !== null && value !== undefined)
	)
		return undefined
	const errors = error.errors ?? []
	if (errors.some((entry) => (entry.path?.length ?? 0) > 0)) return undefined
	const rejections = (errors.length > 0 ? errors.map((entry) => entry.type) : [error.type]).map(
		rejectionOf,
	)
	const [first] = rejections
	return rejections.every((rejection) => rejection !== undefined) ? first : undefined
}

function unconfirmed(write: Write, httpStatus?: number): TaskBoardError {
	return taskBoardError('OUTCOME_UNKNOWN', write.unconfirmed, {
		taskId: write.taskId,
		outcomeUnknown: true,
		httpStatus,
	})
}

const rejectionMessages = {
	RATE_LIMITED: 'Linear rate-limited the request',
	AUTHENTICATION_FAILED: 'Linear did not accept the configured token',
	ACCESS_DENIED: 'The Linear token cannot access this board',
	REJECTED: 'Linear rejected the request',
} as const satisfies Record<Rejection, string>

/** Maps any failure to allowlisted fields. Never retain or serialize `error`. */
export function linearFailure(error: unknown, write?: Write): TaskBoardError {
	if (!(error instanceof LinearError))
		return write === undefined
			? taskBoardError('UNAVAILABLE', 'Linear could not complete the request.')
			: unconfirmed(write)
	const httpStatus =
		typeof error.status === 'number' && Number.isInteger(error.status) ? error.status : undefined
	const rejection =
		write === undefined
			? (rejectionOf(error.type) ??
				(error.type === LinearErrorType.GraphqlError ? 'REJECTED' : undefined))
			: refusedBeforeExecution(error)
	if (rejection === undefined)
		return write === undefined
			? taskBoardError('UNAVAILABLE', 'Linear could not complete the request.', { httpStatus })
			: unconfirmed(write, httpStatus)
	const retryAfter = error instanceof RatelimitedLinearError ? error.retryAfter : undefined
	const detail = rejection === 'REJECTED' && error.type !== undefined ? ` (${error.type})` : ''
	return taskBoardError(
		rejection,
		`${rejectionMessages[rejection]}${detail}${write === undefined ? '' : '; it was not applied'}.`,
		{
			taskId: write?.taskId,
			httpStatus,
			retryAfterSeconds:
				rejection === 'RATE_LIMITED' &&
				typeof retryAfter === 'number' &&
				Number.isFinite(retryAfter) &&
				retryAfter >= 0
					? retryAfter
					: undefined,
		},
	)
}

function lower(value: string | undefined): string | undefined {
	return value?.toLowerCase()
}

function boardIssue(issue: Issue): BoardIssue {
	return {
		id: issue.id.toLowerCase(),
		identifier: issue.identifier,
		title: issue.title,
		url: issue.url,
		description: issue.description ?? '',
		teamId: lower(issue.teamId),
		projectId: lower(issue.projectId),
		stateId: lower(issue.stateId),
		updatedAt: issue.updatedAt.toISOString(),
		archived: issue.archivedAt != null || issue.trashed === true,
	}
}

export function makeLinearGateway(
	config: TaskBoardConfig,
	token: Redacted.Redacted<string>,
): BoardGateway {
	const send = <A>(run: (client: LinearClient) => Promise<A>, write?: Write) =>
		Effect.tryPromise({
			// A client per request binds its abort signal to every fetch it makes.
			try: (signal) =>
				run(new LinearClient({ apiKey: Redacted.value(token), signal, redirect: 'error' })),
			catch: (error) => linearFailure(error, write),
		}).pipe(
			Effect.timeoutOrElse({
				duration: LINEAR_REQUEST_TIMEOUT,
				orElse: () =>
					Effect.fail(
						write === undefined
							? taskBoardError('TIMEOUT', 'Linear did not respond within 15 seconds.')
							: unconfirmed(write),
					),
			}),
		)

	const verifyStates = send((client) =>
		client
			.workflowStates({
				filter: { id: { in: TASK_STATUSES.map((status) => config.states[status]) } },
				first: TASK_STATUSES.length,
			})
			.then((connection) =>
				connection.nodes.map((state) => ({
					id: state.id.toLowerCase(),
					teamId: lower(state.teamId),
					type: state.type,
				})),
			),
	).pipe(
		Effect.flatMap((states) =>
			Effect.forEach(
				TASK_STATUSES,
				(status) => {
					const state = states.find((candidate) => candidate.id === config.states[status])
					const expected = expectedStateTypes[status]
					if (state === undefined)
						return Effect.fail(
							taskBoardError(
								'BOARD_MISCONFIGURED',
								`The configured ${status} workflow state is missing or archived in Linear.`,
							),
						)
					if (state.teamId !== config.teamId)
						return Effect.fail(
							taskBoardError(
								'BOARD_MISCONFIGURED',
								`The configured ${status} workflow state belongs to a different team.`,
							),
						)
					if (state.type !== expected)
						return Effect.fail(
							taskBoardError(
								'BOARD_MISCONFIGURED',
								`The configured ${status} workflow state has type "${state.type}"; expected "${expected}".`,
							),
						)
					return Effect.void
				},
				{ discard: true },
			),
		),
	)

	const verifyProject = send((client) =>
		client
			.projects({
				filter: {
					id: { eq: config.projectId },
					accessibleTeams: { some: { id: { eq: config.teamId } } },
				},
				first: 1,
			})
			.then((connection) =>
				connection.nodes.some((project) => project.id.toLowerCase() === config.projectId),
			),
	).pipe(
		Effect.flatMap((found) =>
			found
				? Effect.void
				: Effect.fail(
						taskBoardError(
							'BOARD_MISCONFIGURED',
							'The configured Linear project is unavailable, archived, or not associated with the configured team.',
						),
					),
		),
	)

	const listPage = (query: IssueQuery, after: string | undefined) =>
		send((client) =>
			client
				.issues({
					filter: {
						team: { id: { eq: config.teamId } },
						project: { id: { eq: config.projectId } },
						description: { contains: query.ownerMarker },
						...(query.stateId === undefined ? {} : { state: { id: { eq: query.stateId } } }),
					},
					first: LINEAR_PAGE_SIZE,
					includeArchived: true,
					orderBy: LinearDocument.PaginationOrderBy.UpdatedAt,
					...(after === undefined ? {} : { after }),
				})
				.then((connection) => ({
					issues: connection.nodes.map(boardIssue),
					hasNextPage: connection.pageInfo.hasNextPage,
					endCursor: connection.pageInfo.endCursor ?? undefined,
				})),
		)

	return {
		verifyBoard: () =>
			Effect.all([verifyStates, verifyProject], { concurrency: 'unbounded', discard: true }),

		readIssue: (id) =>
			send((client) =>
				client
					.issues({ filter: { id: { eq: id } }, includeArchived: true, first: 1 })
					.then((connection) => {
						const issue = connection.nodes[0]
						return issue === undefined ? undefined : boardIssue(issue)
					}),
			),

		listIssues: (query) =>
			Effect.gen(function* () {
				const issues: Array<BoardIssue> = []
				let after: string | undefined
				for (let page = 0; page < LINEAR_MAX_PAGES; page++) {
					const result = yield* listPage(query, after)
					issues.push(...result.issues)
					if (!result.hasNextPage) return issues
					if (result.endCursor === undefined)
						return yield* taskBoardError(
							'UNAVAILABLE',
							'Linear returned an incomplete page of task cards.',
						)
					after = result.endCursor
				}
				return yield* taskBoardError(
					'TOO_MANY_TASKS',
					`More than ${LINEAR_MAX_PAGES * LINEAR_PAGE_SIZE} task cards match this Lead session; filter by status.`,
				)
			}),

		createIssue: (input) =>
			send(
				(client) =>
					client
						.createIssue({
							id: input.id,
							teamId: config.teamId,
							projectId: config.projectId,
							stateId: input.stateId,
							title: input.title,
							description: input.description,
						})
						.then((payload) => payload.success),
				{
					taskId: input.id,
					unconfirmed: `Linear did not confirm creating task ${input.id}; it may exist. Run task_list before creating another card.`,
				},
			).pipe(
				Effect.flatMap((success) =>
					success
						? Effect.void
						: Effect.fail(
								taskBoardError('REJECTED', 'Linear did not create the task card.', {
									taskId: input.id,
								}),
							),
				),
			),

		updateIssue: (id, input) =>
			send((client) => client.updateIssue(id, input).then((payload) => payload.success), {
				taskId: id,
				unconfirmed: `Linear did not confirm updating task ${id}; it may or may not have changed. Run task_list before retrying.`,
			}).pipe(
				Effect.flatMap((success) =>
					success
						? Effect.void
						: Effect.fail(
								taskBoardError('REJECTED', `Linear did not update task ${id}.`, { taskId: id }),
							),
				),
			),
	}
}

export const openLinearBoard: OpenBoard = (config) =>
	readLinearToken(config).pipe(Effect.map((token) => makeLinearGateway(config, token)))
