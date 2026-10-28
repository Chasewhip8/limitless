import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { Cause, Effect, Exit, Fiber, Redacted, Tracer } from 'effect'
import { TestClock } from 'effect/testing'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TaskBoardConfig } from '../tools/tasks/config'
import { encodeTaskBoardError, type TaskBoardError } from '../tools/tasks/errors'
import {
	LINEAR_MAX_PAGES,
	LINEAR_PAGE_SIZE,
	makeLinearGateway,
	openLinearBoard,
} from '../tools/tasks/linear'
import { taskBoardTools } from '../tools/tasks/tools'
import { testToolContext, testToolExecutor } from './execution'

// The SDK adapter against a stubbed GraphQL transport: the real @linear/sdk
// builds every request and parses every response; only fetch is replaced.

const TOKEN = 'lin_api_SECRET_TOKEN_VALUE'
const SECRET_TEXT = 'confidential assignment text'
const config: TaskBoardConfig = {
	teamId: '00000000-0000-4000-8000-00000000000a',
	projectId: '00000000-0000-4000-8000-00000000000b',
	states: {
		in_progress: '00000000-0000-4000-8000-000000000001',
		in_review: '00000000-0000-4000-8000-000000000002',
		done: '00000000-0000-4000-8000-000000000003',
		canceled: '00000000-0000-4000-8000-000000000004',
	},
	tokenEnv: 'LIMITLESS_TEST_LINEAR_TOKEN',
}
const TASK = '10000000-0000-4000-8000-000000000000'

type Call = {
	readonly url: string
	readonly operation: string
	readonly variables: Record<string, unknown>
	readonly init: RequestInit
}
let calls: Array<Call>
let respond: (call: Call) => Response | Promise<Response>
const temporary: Array<string> = []

beforeEach(() => {
	calls = []
	respond = () => {
		throw new Error('unexpected request')
	}
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as { query: string; variables?: object }
		const operation = /(?:query|mutation)\s+(\w+)/u.exec(body.query)?.[1] ?? 'unknown'
		const call = { url, operation, variables: { ...body.variables }, init }
		calls.push(call)
		return respond(call)
	})
})

afterEach(async () => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
})

const graphql = (data: unknown, init: ResponseInit = {}) => Response.json({ data }, init)
const graphqlError = (type: string, status: number, headers: Record<string, string> = {}) =>
	Response.json(
		{
			errors: [
				{
					message: `failed for ${SECRET_TEXT}`,
					extensions: { type, userPresentableMessage: `Rejected ${SECRET_TEXT}` },
				},
			],
		},
		{ status, headers },
	)

function issueNode(overrides: Record<string, unknown> = {}) {
	return {
		id: TASK.toUpperCase(),
		identifier: 'LIM-1',
		title: 'Customer pagination',
		url: 'https://linear.app/example/issue/LIM-1',
		description: SECRET_TEXT,
		createdAt: '2026-10-27T12:00:00.000Z',
		updatedAt: '2026-10-27T12:30:00.000Z',
		archivedAt: null,
		trashed: null,
		team: { id: config.teamId },
		project: { id: config.projectId },
		state: { id: config.states.in_review },
		reactions: [],
		sharedAccess: { sharedWithUsers: [] },
		...overrides,
	}
}

function connection(nodes: Array<unknown>, endCursor?: string) {
	return {
		nodes,
		pageInfo: {
			hasNextPage: endCursor !== undefined,
			hasPreviousPage: false,
			endCursor: endCursor ?? null,
			startCursor: null,
		},
	}
}

const gateway = () => makeLinearGateway(config, Redacted.make(TOKEN))

function authorizationOf(call: Call | undefined): string | undefined {
	return (call?.init.headers as Record<string, string> | undefined)?.Authorization
}

async function failureOf<A>(effect: Effect.Effect<A, TaskBoardError>) {
	const exit = await Effect.runPromiseExit(effect)
	if (Exit.isSuccess(exit)) throw new Error('expected a failure')
	// Nothing about the original error may survive: not the token, the
	// request variables, or Linear's response.
	const rendered = `${Cause.pretty(exit.cause)} ${JSON.stringify(exit.cause)}`
	expect(rendered).not.toContain(TOKEN)
	expect(rendered).not.toContain(SECRET_TEXT)
	const error = Cause.squash(exit.cause) as TaskBoardError
	const encoded = encodeTaskBoardError('hint')(error)
	expect(JSON.stringify({ message: encoded.message, metadata: encoded.metadata })).not.toMatch(
		new RegExp(`${TOKEN}|${SECRET_TEXT}`, 'u'),
	)
	expect(encoded.error).toBeUndefined()
	return error
}

describe('requests', () => {
	test('lists every page of owner candidates on the fixed board, including archived cards', async () => {
		let page = 0
		respond = () => {
			page++
			return graphql({
				issues: connection(
					[issueNode({ archivedAt: page === 2 ? '2026-10-27T13:00:00.000Z' : null })],
					page === 1 ? 'cursor-1' : undefined,
				),
			})
		}
		const issues = await Effect.runPromise(
			gateway().listIssues({
				ownerMarker: 'limitless-task:v1:lead:ses_lead',
				stateId: config.states.done,
			}),
		)
		expect(calls.map((call) => call.operation)).toEqual(['issues', 'issues'])
		expect(calls[0]?.variables).toEqual({
			filter: {
				team: { id: { eq: config.teamId } },
				project: { id: { eq: config.projectId } },
				description: { contains: 'limitless-task:v1:lead:ses_lead' },
				state: { id: { eq: config.states.done } },
			},
			first: LINEAR_PAGE_SIZE,
			includeArchived: true,
			orderBy: 'updatedAt',
		})
		expect(calls[1]?.variables).toMatchObject({ after: 'cursor-1', includeArchived: true })
		expect(issues).toEqual([
			{
				id: TASK,
				identifier: 'LIM-1',
				title: 'Customer pagination',
				url: 'https://linear.app/example/issue/LIM-1',
				description: SECRET_TEXT,
				teamId: config.teamId,
				projectId: config.projectId,
				stateId: config.states.in_review,
				updatedAt: '2026-10-27T12:30:00.000Z',
				archived: false,
			},
			expect.objectContaining({ archived: true }),
		])
	})

	test('fails explicitly instead of truncating a long list', async () => {
		respond = () => graphql({ issues: connection([issueNode()], 'more') })
		const error = await failureOf(gateway().listIssues({ ownerMarker: 'marker' }))
		expect(error.code).toBe('TOO_MANY_TASKS')
		expect(calls).toHaveLength(LINEAR_MAX_PAGES)
	})

	test('sends the token only to the fixed endpoint, refuses redirects, and binds an abort signal', async () => {
		respond = () => graphql({ issues: connection([]) })
		expect(await Effect.runPromise(gateway().readIssue(TASK))).toBeUndefined()
		const [call] = calls
		expect(call?.url).toBe('https://api.linear.app/graphql')
		expect(call?.init.redirect).toBe('error')
		expect(call?.init.signal).toBeInstanceOf(AbortSignal)
		expect(authorizationOf(call)).toBe(TOKEN)
		expect(call?.variables).toEqual({
			filter: { id: { eq: TASK } },
			includeArchived: true,
			first: 1,
		})
	})

	test('creates with the preallocated ID in one request, without reading the issue back', async () => {
		respond = () => graphql({ issueCreate: { success: true, lastSyncId: 1, issue: { id: TASK } } })
		await Effect.runPromise(
			gateway().createIssue({
				id: TASK,
				title: 'Customer pagination',
				description: SECRET_TEXT,
				stateId: config.states.in_progress,
			}),
		)
		expect(calls.map((call) => call.operation)).toEqual(['createIssue'])
		expect(calls[0]?.variables).toEqual({
			input: {
				id: TASK,
				teamId: config.teamId,
				projectId: config.projectId,
				stateId: config.states.in_progress,
				title: 'Customer pagination',
				description: SECRET_TEXT,
			},
		})
	})

	test('updates state and description in one mutation', async () => {
		respond = () => graphql({ issueUpdate: { success: true, lastSyncId: 2, issue: { id: TASK } } })
		await Effect.runPromise(
			gateway().updateIssue(TASK, { stateId: config.states.done, description: SECRET_TEXT }),
		)
		expect(calls.map((call) => [call.operation, call.variables])).toEqual([
			[
				'updateIssue',
				{ id: TASK, input: { stateId: config.states.done, description: SECRET_TEXT } },
			],
		])
		respond = () => graphql({ issueUpdate: { success: false, lastSyncId: 3 } })
		const error = await failureOf(
			gateway().updateIssue(TASK, { stateId: config.states.done, description: SECRET_TEXT }),
		)
		expect(error).toMatchObject({ code: 'REJECTED', taskId: TASK })
	})
})

describe('board verification', () => {
	const state = (status: keyof TaskBoardConfig['states'], overrides = {}) => ({
		id: config.states[status],
		name: status,
		type: { in_progress: 'started', in_review: 'started', done: 'completed', canceled: 'canceled' }[
			status
		],
		team: { id: config.teamId },
		...overrides,
	})
	const answer =
		(states: Array<unknown>, projects: Array<unknown> = [{ id: config.projectId }]) =>
		(call: Call) =>
			call.operation === 'workflowStates'
				? graphql({ workflowStates: connection(states) })
				: graphql({ projects: connection(projects) })
	const valid = () => [state('in_progress'), state('in_review'), state('done'), state('canceled')]

	test('checks the configured states and project without changing them', async () => {
		respond = answer(valid())
		await Effect.runPromise(gateway().verifyBoard())
		expect(calls.map((call) => call.operation).sort()).toEqual(['projects', 'workflowStates'])
		expect(calls.find((call) => call.operation === 'workflowStates')?.variables).toEqual({
			filter: { id: { in: Object.values(config.states) } },
			first: 4,
		})
		expect(calls.find((call) => call.operation === 'projects')?.variables).toEqual({
			filter: {
				id: { eq: config.projectId },
				accessibleTeams: { some: { id: { eq: config.teamId } } },
			},
			first: 1,
		})
	})

	test.each([
		['a missing state', valid().slice(1), [{ id: config.projectId }], 'missing or archived'],
		[
			'another team’s state',
			[...valid().slice(0, 3), state('canceled', { team: { id: config.projectId } })],
			[{ id: config.projectId }],
			'different team',
		],
		[
			'a state of the wrong type',
			[state('in_progress', { type: 'unstarted' }), ...valid().slice(1)],
			[{ id: config.projectId }],
			'expected "started"',
		],
		['a project outside the team', valid(), [], 'not associated with the configured team'],
	])('rejects %s', async (_name, states, projects, message) => {
		respond = answer(states, projects)
		const error = await failureOf(gateway().verifyBoard())
		expect(error.code).toBe('BOARD_MISCONFIGURED')
		expect(error.message).toContain(message)
	})
})

describe('failures', () => {
	test('a slow read times out and aborts its request', async () => {
		let signal: AbortSignal | undefined
		respond = (call) => {
			signal = call.init.signal ?? undefined
			return new Promise<Response>(() => {})
		}
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(Effect.flip(gateway().readIssue(TASK)))
				yield* Effect.yieldNow
				yield* TestClock.adjust('15 seconds')
				return yield* Fiber.join(fiber)
			}).pipe(Effect.provide(TestClock.layer())),
		)
		expect(error.code).toBe('TIMEOUT')
		expect(signal?.aborted).toBe(true)
	})

	test('an unanswered write reports an unknown outcome and is not retried', async () => {
		respond = () => new Promise<Response>(() => {})
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					Effect.flip(
						gateway().updateIssue(TASK, { stateId: config.states.done, description: SECRET_TEXT }),
					),
				)
				yield* Effect.yieldNow
				yield* TestClock.adjust('15 seconds')
				return yield* Fiber.join(fiber)
			}).pipe(Effect.provide(TestClock.layer())),
		)
		expect(error).toMatchObject({ code: 'OUTCOME_UNKNOWN', taskId: TASK, outcomeUnknown: true })
		expect(calls).toHaveLength(1)
	})

	test('a network failure during create is ambiguous; during a read it is not', async () => {
		respond = () => {
			throw new TypeError(`fetch failed: Authorization ${TOKEN} body ${SECRET_TEXT}`)
		}
		const created = await failureOf(
			gateway().createIssue({
				id: TASK,
				title: 'Title',
				description: SECRET_TEXT,
				stateId: config.states.in_progress,
			}),
		)
		expect(created).toMatchObject({ code: 'OUTCOME_UNKNOWN', taskId: TASK, outcomeUnknown: true })
		expect(created.message).toContain('Run task_list before creating another card')
		expect(calls).toHaveLength(1)
		expect((await failureOf(gateway().readIssue(TASK))).code).toBe('UNAVAILABLE')
	})

	test('rate limits keep only the retry delay', async () => {
		respond = () => graphqlError('ratelimited', 400, { 'retry-after': '30' })
		const error = await failureOf(
			gateway().updateIssue(TASK, { stateId: config.states.done, description: SECRET_TEXT }),
		)
		expect(error).toMatchObject({
			code: 'RATE_LIMITED',
			retryAfterSeconds: 30,
			httpStatus: 400,
			taskId: TASK,
		})
		expect(error.outcomeUnknown).toBeUndefined()
	})

	test.each([
		[401, 'AUTHENTICATION_FAILED'],
		[403, 'ACCESS_DENIED'],
		[429, 'RATE_LIMITED'],
	])('maps HTTP %i without Linear’s response text', async (status, code) => {
		respond = () => new Response(`denied ${SECRET_TEXT}`, { status })
		const error = await failureOf(gateway().listIssues({ ownerMarker: 'marker' }))
		expect(error).toMatchObject({ code, httpStatus: status })
	})

	test('a rejected mutation is definitive and keeps no Linear message', async () => {
		respond = () => graphqlError('invalid input', 400)
		const error = await failureOf(
			gateway().createIssue({
				id: TASK,
				title: 'Title',
				description: SECRET_TEXT,
				stateId: config.states.in_progress,
			}),
		)
		expect(error).toMatchObject({ code: 'REJECTED', taskId: TASK })
		expect(error.outcomeUnknown).toBeUndefined()
	})

	test('a mutation that returned a result beside its errors has an unknown outcome', async () => {
		respond = () =>
			Response.json({
				data: { issueCreate: { success: true, lastSyncId: 1, issue: null } },
				errors: [
					{
						message: `forbidden ${SECRET_TEXT}`,
						path: ['issueCreate', 'issue'],
						extensions: { type: 'forbidden' },
					},
				],
			})
		const error = await failureOf(
			gateway().createIssue({
				id: TASK,
				title: 'Title',
				description: SECRET_TEXT,
				stateId: config.states.in_progress,
			}),
		)
		expect(error).toMatchObject({ code: 'OUTCOME_UNKNOWN', taskId: TASK, outcomeUnknown: true })
	})

	const executionErrors = (...errors: Array<{ type: string; path?: Array<string> }>) =>
		Response.json({
			data: null,
			errors: errors.map(({ type, path }) => ({
				message: `${type} ${SECRET_TEXT}`,
				...(path === undefined ? {} : { path }),
				extensions: { type },
			})),
		})

	test.each([
		[
			'a refusal raised during execution',
			[{ type: 'user error', path: ['issueCreate', 'lastSyncId'] }],
		],
		['a permission error raised during execution', [{ type: 'forbidden', path: ['issueCreate'] }]],
		['a refusal beside an internal error', [{ type: 'invalid input' }, { type: 'internal error' }]],
	])('%s leaves a write’s outcome unknown', async (_name, errors) => {
		respond = () => executionErrors(...errors)
		const error = await failureOf(
			gateway().createIssue({
				id: TASK,
				title: 'Title',
				description: SECRET_TEXT,
				stateId: config.states.in_progress,
			}),
		)
		expect(error).toMatchObject({ code: 'OUTCOME_UNKNOWN', taskId: TASK, outcomeUnknown: true })
	})

	test('refusals of the whole request are definitive', async () => {
		respond = () => executionErrors({ type: 'invalid input' }, { type: 'forbidden' })
		const error = await failureOf(
			gateway().updateIssue(TASK, { stateId: config.states.done, description: SECRET_TEXT }),
		)
		expect(error).toMatchObject({ code: 'REJECTED', taskId: TASK })
		expect(error.message).toContain('it was not applied')
		expect(error.outcomeUnknown).toBeUndefined()
	})

	test('a GraphQL execution error is ambiguous for writes and a rejection for reads', async () => {
		respond = () => graphqlError('graphql error', 200)
		const write = await failureOf(
			gateway().updateIssue(TASK, { stateId: config.states.done, description: SECRET_TEXT }),
		)
		expect(write).toMatchObject({ code: 'OUTCOME_UNKNOWN', outcomeUnknown: true })
		expect((await failureOf(gateway().readIssue(TASK))).code).toBe('REJECTED')
	})

	test('a server error during a write is ambiguous', async () => {
		respond = () => new Response('upstream failure', { status: 502 })
		const error = await failureOf(
			gateway().updateIssue(TASK, { stateId: config.states.done, description: SECRET_TEXT }),
		)
		expect(error).toMatchObject({ code: 'OUTCOME_UNKNOWN', httpStatus: 502, outcomeUnknown: true })
	})
})

describe('credentials', () => {
	async function tokenFile(contents: string) {
		const directory = await mkdtemp(join(tmpdir(), 'limitless-linear-token-'))
		temporary.push(directory)
		const path = join(directory, 'token')
		await writeFile(path, contents)
		return path
	}

	const authorization = async (board: TaskBoardConfig) => {
		respond = () => graphql({ issues: connection([]) })
		const gateway = await Effect.runPromise(openLinearBoard(board))
		await Effect.runPromise(gateway.readIssue(TASK))
		return authorizationOf(calls.at(-1))
	}

	test('reads the environment lazily, and a token file overrides it', async () => {
		vi.stubEnv(config.tokenEnv, ` ${TOKEN}\n`)
		expect(await authorization(config)).toBe(TOKEN)
		const path = await tokenFile('lin_api_from_file\n')
		expect(await authorization({ ...config, tokenFile: path })).toBe('lin_api_from_file')
	})

	test('missing, empty, unreadable, and multi-line tokens fail before any request', async () => {
		vi.stubEnv(config.tokenEnv, '')
		const missing = await failureOf(openLinearBoard(config))
		expect(missing).toMatchObject({ code: 'TOKEN_MISSING' })
		expect(missing.message).toContain(config.tokenEnv)

		const empty = await failureOf(
			openLinearBoard({ ...config, tokenFile: await tokenFile('  \n') }),
		)
		expect(empty.code).toBe('TOKEN_MISSING')

		const absent = join(tmpdir(), 'limitless-missing-linear-token', 'token')
		const unreadable = await failureOf(openLinearBoard({ ...config, tokenFile: absent }))
		expect(unreadable).toMatchObject({ code: 'TOKEN_UNREADABLE' })
		expect(unreadable.message).toContain('ENOENT')
		expect(unreadable.message).not.toContain(absent)

		vi.stubEnv(config.tokenEnv, `${TOKEN}\nInjected: header`)
		expect((await failureOf(openLinearBoard(config))).code).toBe('TOKEN_UNREADABLE')
		expect(calls).toEqual([])
	})

	test('no tracing span records the token', async () => {
		vi.stubEnv(config.tokenEnv, TOKEN)
		respond = () => graphql({ issues: connection([issueNode()]) })
		const spans: Array<Tracer.NativeSpan> = []
		const tracer = Tracer.make({
			span(options) {
				const span = new Tracer.NativeSpan(options)
				spans.push(span)
				return span
			},
		})
		const lead = { projectRoot: '/project', sessionId: 'ses_lead', agent: 'lead' }
		const tools = taskBoardTools(testToolExecutor(lead), config, {
			openBoard: openLinearBoard,
			readSession: () => Effect.die('unused'),
		})
		await Effect.runPromise(
			tools.task_list.execute({}, testToolContext(lead)).pipe(Effect.withTracer(tracer)),
		)
		// Spans keep their results, so the recorder sees what any span consumer would.
		expect(spans.map((span) => span.name)).toContain('listTasks')
		expect(inspect(spans, { depth: 30 })).toContain('LIM-1')
		expect(inspect(spans, { depth: 30 })).not.toContain(TOKEN)
	})
})
