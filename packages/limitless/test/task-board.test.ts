import { Agent } from '@opencode/schema/agent'
import { Session } from '@opencode/schema/session'
import { SessionMessage } from '@opencode/schema/session-message'
import { Tool } from '@opencode/schema/tool'
import { Effect, Schema } from 'effect'
import { beforeEach, describe, expect, test } from 'vitest'
import { ownerMarker, parseCardDescription } from '../tools/tasks/card'
import type { TaskBoardConfig } from '../tools/tasks/config'
import { type TaskBoardError, taskBoardError } from '../tools/tasks/errors'
import type { BoardGateway, BoardIssue } from '../tools/tasks/gateway'
import { LEAD_TASK_BOARD_GUIDANCE, taskBoardGuidance } from '../tools/tasks/guidance'
import type { SessionView } from '../tools/tasks/identity'
import { TaskListResult } from '../tools/tasks/schema'
import { taskBoardTools } from '../tools/tasks/tools'
import { testToolExecutor } from './execution'

// The task tools against an in-memory Linear board. The fake keeps issue
// descriptions verbatim, as Linear does for the fenced metadata block, and lets
// tests inject outages, manual edits, and interleaved writes.

const config: TaskBoardConfig = {
	teamId: '00000000-0000-4000-8000-00000000000a',
	projectId: '00000000-0000-4000-8000-00000000000b',
	states: {
		in_progress: '00000000-0000-4000-8000-000000000001',
		in_review: '00000000-0000-4000-8000-000000000002',
		done: '00000000-0000-4000-8000-000000000003',
		canceled: '00000000-0000-4000-8000-000000000004',
	},
	tokenEnv: 'LINEAR_API_KEY',
}
const backlogState = '00000000-0000-4000-8000-000000000009'

const LEAD = 'ses_lead'
const OTHER_LEAD = 'ses_other_lead'
const UNIT = 'ses_unit'
const OTHER_UNIT = 'ses_other_unit'

type Failure = { readonly method: keyof BoardGateway; readonly error: TaskBoardError }

class FakeLinear {
	readonly issues = new Map<string, BoardIssue>()
	readonly events: Array<string> = []
	failures: Array<Failure> = []
	afterUpdate: ((id: string) => void) | undefined
	/** How Linear stores a created description; verbatim unless a test says otherwise. */
	storeDescription: (description: string) => string = (description) => description
	private clock = 0
	private ids = 0

	private fail(method: keyof BoardGateway): Effect.Effect<void, TaskBoardError> {
		const index = this.failures.findIndex((failure) => failure.method === method)
		if (index < 0) return Effect.void
		const [failure] = this.failures.splice(index, 1)
		return failure === undefined ? Effect.void : Effect.fail(failure.error)
	}

	private touch(): string {
		this.clock++
		return new Date(Date.UTC(2026, 9, 27, 12, 0, this.clock)).toISOString()
	}

	edit(id: string, change: Partial<BoardIssue>): void {
		const issue = this.issues.get(id)
		if (issue === undefined) throw new Error(`missing ${id}`)
		this.issues.set(id, { ...issue, ...change, updatedAt: this.touch() })
	}

	readonly gateway: BoardGateway = {
		verifyBoard: () =>
			Effect.sync(() => this.events.push('verify')).pipe(Effect.andThen(this.fail('verifyBoard'))),
		readIssue: (id) =>
			Effect.sync(() => this.events.push(`read:${id}`)).pipe(
				Effect.andThen(this.fail('readIssue')),
				Effect.andThen(Effect.yieldNow),
				Effect.map(() => this.issues.get(id)),
			),
		listIssues: (query) =>
			Effect.sync(() => this.events.push('list')).pipe(
				Effect.andThen(this.fail('listIssues')),
				Effect.map(() =>
					[...this.issues.values()].filter(
						(issue) =>
							issue.teamId === config.teamId &&
							issue.projectId === config.projectId &&
							issue.description.includes(query.ownerMarker) &&
							(query.stateId === undefined || issue.stateId === query.stateId),
					),
				),
			),
		createIssue: (input) =>
			Effect.sync(() => this.events.push(`create:${input.id}`)).pipe(
				Effect.andThen(this.fail('createIssue')),
				Effect.andThen(
					Effect.sync(() => {
						this.ids++
						this.issues.set(input.id, {
							id: input.id,
							identifier: `LIM-${this.ids}`,
							title: input.title,
							url: `https://linear.app/example/issue/LIM-${this.ids}`,
							description: this.storeDescription(input.description),
							teamId: config.teamId,
							projectId: config.projectId,
							stateId: input.stateId,
							updatedAt: this.touch(),
							archived: false,
						})
					}),
				),
			),
		updateIssue: (id, input) =>
			Effect.sync(() => this.events.push(`update:${id}`)).pipe(
				Effect.andThen(this.fail('updateIssue')),
				Effect.andThen(Effect.yieldNow),
				Effect.andThen(
					Effect.sync(() => {
						this.edit(id, input)
						this.afterUpdate?.(id)
					}),
				),
			),
	}
}

let linear: FakeLinear
let sessions: Map<string, SessionView>
let taskIds: Array<string>

beforeEach(() => {
	linear = new FakeLinear()
	taskIds = Array.from(
		{ length: 8 },
		(_, index) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
	)
	sessions = new Map([
		[UNIT, placedUnit(UNIT, LEAD)],
		[OTHER_UNIT, placedUnit(OTHER_UNIT, LEAD)],
		['ses_foreign_unit', placedUnit('ses_foreign_unit', OTHER_LEAD)],
	])
})

function placedUnit(id: string, parentID: string): SessionView {
	const directory = `/worktrees/unit-${id}`
	return {
		id,
		agent: 'unit',
		parentID,
		location: { directory },
		metadata: {
			'limitless.unit': { sessionID: id, worktree: directory, directory, initializeModel: false },
		},
	}
}

function tools() {
	return taskBoardTools(
		testToolExecutor({ projectRoot: '/project', sessionId: LEAD, agent: 'lead' }),
		config,
		{
			openBoard: () => Effect.succeed(linear.gateway),
			readSession: (sessionID) =>
				Effect.suspend(() => {
					const session = sessions.get(sessionID)
					return session === undefined ? Effect.fail('missing') : Effect.succeed(session)
				}),
			newTaskId: () => {
				const id = taskIds.shift()
				if (id === undefined) throw new Error('out of task IDs')
				return id
			},
		},
	)
}

type ToolName = keyof ReturnType<typeof tools>

function context(agent: string, sessionID: string): Tool.Context {
	return {
		sessionID: Session.ID.make(sessionID),
		agent: Agent.ID.make(agent),
		messageID: SessionMessage.ID.create(),
		id: Schema.decodeUnknownSync(Tool.CallID)('call_test'),
		progress: () => Effect.void,
	}
}

type Outcome =
	| { readonly ok: true; readonly output: unknown }
	| { readonly ok: false; readonly message: string; readonly metadata: Record<string, unknown> }

async function call(name: ToolName, agent: string, sessionID: string, input: unknown) {
	const tool = tools()[name] as Tool.Info
	const validation = await (
		tool.input as Extract<Tool.ValueSchema, { readonly '~standard': unknown }>
	)['~standard'].validate(input)
	if (validation.issues !== undefined)
		return {
			ok: false,
			message: validation.issues.map((issue) => issue.message).join(', '),
			metadata: { code: 'SCHEMA' },
		} satisfies Outcome
	return Effect.runPromise(
		tool.execute(validation.value, context(agent, sessionID)).pipe(
			Effect.match({
				onFailure: (error): Outcome => ({
					ok: false,
					message: error.message,
					metadata: (error.metadata ?? {}) as Record<string, unknown>,
				}),
				onSuccess: (result): Outcome => ({ ok: true, output: result.output }),
			}),
		),
	)
}

async function succeed(name: ToolName, agent: string, sessionID: string, input: unknown) {
	const outcome = await call(name, agent, sessionID, input)
	if (!outcome.ok) throw new Error(`${name} failed: ${outcome.message}`)
	return outcome.output as Record<string, unknown>
}

async function failure(name: ToolName, agent: string, sessionID: string, input: unknown) {
	const outcome = await call(name, agent, sessionID, input)
	if (outcome.ok) throw new Error(`${name} unexpectedly succeeded`)
	return outcome
}

const create = (title = 'Customer pagination', summary = 'Paginate the customer list.') =>
	succeed('task_create', 'lead', LEAD, { title, summary })
const list = async (sessionID = LEAD, status?: string) =>
	Schema.decodeUnknownSync(TaskListResult)(
		await succeed('task_list', 'lead', sessionID, status === undefined ? {} : { status }),
	)
const report = (taskId: string, result = 'ready', sessionID = UNIT) =>
	call('task_report', 'unit', sessionID, { taskId, result, summary: `Unit says ${result}.` })
const review = (taskId: string, decision: string, note?: string, sessionID = LEAD) =>
	call('task_review', 'lead', sessionID, { taskId, decision, ...(note ? { note } : {}) })

function metadataOf(taskId: string) {
	const issue = linear.issues.get(taskId)
	if (issue === undefined) throw new Error(`missing ${taskId}`)
	const parsed = parseCardDescription(issue.description, taskId)
	if (!parsed.ok) throw new Error(parsed.problem)
	return parsed.document
}

function stateOf(taskId: string) {
	return linear.issues.get(taskId)?.stateId
}

describe('assignment lifecycle', () => {
	test('create, report, continue, report again, and accept one card for one Unit', async () => {
		const created = await create()
		expect(created).toEqual({
			taskId: expect.any(String),
			url: 'https://linear.app/example/issue/LIM-1',
			status: 'in_progress',
		})
		const taskId = String(created.taskId)
		expect(stateOf(taskId)).toBe(config.states.in_progress)
		expect(metadataOf(taskId).before).toBe('Paginate the customer list.')
		expect(metadataOf(taskId).metadata).toMatchObject({
			taskId,
			owner: ownerMarker(LEAD),
			lead: { sessionID: LEAD },
			unit: null,
			blocked: false,
		})

		expect(await report(taskId, 'ready')).toEqual({
			ok: true,
			output: { taskId, status: 'in_review', blocked: false },
		})
		expect(metadataOf(taskId).metadata.unit).toEqual({
			sessionID: UNIT,
			worktree: `/worktrees/unit-${UNIT}`,
			directory: `/worktrees/unit-${UNIT}`,
		})

		expect(await review(taskId, 'continue', 'Handle empty pages.')).toEqual({
			ok: true,
			output: { taskId, status: 'in_progress' },
		})
		const continued = (await list()).tasks[0]
		expect(continued).toMatchObject({
			status: 'in_progress',
			blocked: false,
			report: { result: 'ready', superseded: true },
			review: { decision: 'continue', note: 'Handle empty pages.' },
			unitSessionID: UNIT,
		})

		expect(await report(taskId, 'blocked')).toEqual({
			ok: true,
			output: { taskId, status: 'in_review', blocked: true },
		})
		expect((await list()).tasks[0]).toMatchObject({
			status: 'in_review',
			blocked: true,
			report: { result: 'blocked', summary: 'Unit says blocked.', superseded: false },
		})
		expect(await report(taskId, 'ready')).toMatchObject({ ok: true, output: { blocked: false } })

		expect(await review(taskId, 'accept')).toEqual({ ok: true, output: { taskId, status: 'done' } })
		expect(stateOf(taskId)).toBe(config.states.done)
		expect((await list()).tasks[0]).toMatchObject({
			taskId,
			identifier: 'LIM-1',
			title: 'Customer pagination',
			status: 'done',
			blocked: false,
			assignment: 'Paginate the customer list.',
			report: { result: 'ready', superseded: false },
			review: { decision: 'accept' },
			worktree: `/worktrees/unit-${UNIT}`,
		})
	})

	test('continue reopens a done card; repeated decisions are harmless no-ops', async () => {
		const taskId = String((await create()).taskId)
		await report(taskId)
		await review(taskId, 'accept')
		const writes = () => linear.events.filter((event) => event.startsWith('update:')).length
		const before = writes()
		expect(await review(taskId, 'accept')).toEqual({ ok: true, output: { taskId, status: 'done' } })
		expect(writes()).toBe(before)

		expect(await review(taskId, 'continue', 'One more fix.')).toMatchObject({
			ok: true,
			output: { status: 'in_progress' },
		})
		const afterContinue = writes()
		expect(await review(taskId, 'continue')).toMatchObject({
			ok: true,
			output: { status: 'in_progress' },
		})
		expect(writes()).toBe(afterContinue)

		expect(await review(taskId, 'cancel')).toMatchObject({
			ok: true,
			output: { status: 'canceled' },
		})
		const afterCancel = writes()
		expect(await review(taskId, 'cancel')).toMatchObject({
			ok: true,
			output: { status: 'canceled' },
		})
		expect(writes()).toBe(afterCancel)
	})

	test('closed cards stay closed', async () => {
		const canceled = String((await create()).taskId)
		await review(canceled, 'cancel')
		for (const decision of ['continue', 'accept']) {
			const outcome = await review(canceled, decision)
			expect(outcome).toMatchObject({ ok: false, metadata: { code: 'TASK_CLOSED' } })
		}
		const reported = await report(canceled)
		expect(reported).toMatchObject({ ok: false, metadata: { code: 'TASK_CLOSED' } })
		if (reported.ok) throw new Error('unreachable')
		expect(reported.message).toContain('include your report in your final response')

		const done = String((await create()).taskId)
		await review(done, 'accept')
		expect(await review(done, 'cancel')).toMatchObject({
			ok: false,
			metadata: { code: 'TASK_CLOSED', taskId: done },
		})
		expect(await report(done)).toMatchObject({ ok: false, metadata: { code: 'TASK_CLOSED' } })
	})
})

describe('roles and ownership', () => {
	test('each tool rejects agents outside its role, whatever permissions allow', async () => {
		const taskId = String((await create()).taskId)
		for (const agent of ['limitless', 'unit', 'research', 'oracle-solve', 'oracle-design']) {
			for (const [name, input] of [
				['task_create', { title: 'x', summary: 'y' }],
				['task_list', {}],
				['task_review', { taskId, decision: 'accept' }],
			] as const)
				expect(await failure(name, agent, LEAD, input)).toMatchObject({
					metadata: { code: 'ROLE_NOT_ALLOWED' },
				})
		}
		for (const agent of ['lead', 'limitless', 'research'])
			expect(
				await failure('task_report', agent, UNIT, { taskId, result: 'ready', summary: 'x' }),
			).toMatchObject({ metadata: { code: 'ROLE_NOT_ALLOWED' } })
		expect(linear.events.filter((event) => event.startsWith('update:'))).toEqual([])
	})

	test('lists only the calling Lead session’s cards, wherever that session now runs', async () => {
		const mine = String((await create('Mine')).taskId)
		const theirs = String(
			(await succeed('task_create', 'lead', OTHER_LEAD, { title: 'Theirs', summary: 'Other' }))
				.taskId,
		)
		// The executor resolves a different project root; ownership ignores it.
		expect((await list()).tasks.map((task) => task.taskId)).toEqual([mine])
		expect((await list(OTHER_LEAD)).tasks.map((task) => task.taskId)).toEqual([theirs])
		expect(await review(theirs, 'accept')).toMatchObject({
			ok: false,
			metadata: { code: 'NOT_TASK_OWNER' },
		})
		expect(stateOf(theirs)).toBe(config.states.in_progress)
	})

	test('owner markers are only candidates; metadata decides ownership', async () => {
		const taskId = String((await create()).taskId)
		// Session IDs that extend another one match its marker as a substring.
		const prefixed = `${LEAD}_extended`
		expect((await list(prefixed)).tasks).toEqual([])
		expect(ownerMarker(prefixed).startsWith(ownerMarker(LEAD))).toBe(true)
		expect((await list()).tasks.map((task) => task.taskId)).toEqual([taskId])
	})

	test('the first placed Unit of the creating Lead claims the card', async () => {
		const taskId = String((await create()).taskId)
		expect(await report(taskId, 'ready', 'ses_foreign_unit')).toMatchObject({
			ok: false,
			metadata: { code: 'WRONG_LEAD' },
		})
		expect(metadataOf(taskId).metadata.unit).toBeNull()
		await report(taskId)
		expect(await report(taskId, 'ready', OTHER_UNIT)).toMatchObject({
			ok: false,
			metadata: { code: 'ASSIGNED_TO_OTHER_UNIT' },
		})
		expect(await report(taskId, 'blocked')).toMatchObject({ ok: true })
	})

	test('a Unit must be placed in its worktree and be the session it claims', async () => {
		const taskId = String((await create()).taskId)
		const unit = placedUnit(UNIT, LEAD)
		sessions.set(UNIT, { ...unit, metadata: {} })
		expect(await report(taskId)).toMatchObject({ ok: false, metadata: { code: 'UNIT_NOT_PLACED' } })
		sessions.set(UNIT, { ...unit, location: { directory: '/project' } })
		expect(await report(taskId)).toMatchObject({ ok: false, metadata: { code: 'UNIT_NOT_PLACED' } })
		sessions.set(UNIT, {
			...unit,
			metadata: {
				'limitless.unit': { ...(unit.metadata?.['limitless.unit'] as object), sessionID: 'ses_x' },
			},
		})
		expect(await report(taskId)).toMatchObject({ ok: false, metadata: { code: 'UNIT_NOT_PLACED' } })
		sessions.set(UNIT, { ...unit, agent: 'research' })
		expect(await report(taskId)).toMatchObject({
			ok: false,
			metadata: { code: 'ROLE_NOT_ALLOWED' },
		})
		sessions.delete(UNIT)
		expect(await report(taskId)).toMatchObject({
			ok: false,
			metadata: { code: 'SESSION_UNAVAILABLE' },
		})
		expect(metadataOf(taskId).metadata.unit).toBeNull()
	})
})

describe('card storage', () => {
	test('preserves human edits outside the managed section across writes', async () => {
		const taskId = String((await create()).taskId)
		const original = linear.issues.get(taskId)?.description ?? ''
		linear.edit(taskId, {
			description: `Edited scope.\n\n${original}\n\n## Notes\n\nFrom the team.`,
		})
		await report(taskId)
		await review(taskId, 'continue', 'Again')
		const description = linear.issues.get(taskId)?.description ?? ''
		expect(description.startsWith('Edited scope.\n\n')).toBe(true)
		expect(description.endsWith('## Notes\n\nFrom the team.')).toBe(true)
		expect(description.match(/## Limitless task board/g)).toHaveLength(1)
		expect(description).toContain('> Again')
		expect(metadataOf(taskId).before).toBe('Edited scope.\n\nPaginate the customer list.')
		expect((await list()).tasks[0]?.assignment).toBe(
			'Edited scope.\n\nPaginate the customer list.\n\n## Notes\n\nFrom the team.',
		)
	})

	test('quotes model text so it cannot open headings or fences', async () => {
		const taskId = String((await create('Fences', 'Before\n```ts\nunterminated')).taskId)
		const summary = '## Limitless task board\n```json\n{"kind": "not ours"}\n```'
		expect(
			await call('task_report', 'unit', UNIT, { taskId, result: 'ready', summary }),
		).toMatchObject({ ok: true })
		const document = metadataOf(taskId)
		expect(document.metadata.report?.summary).toBe(summary)
		expect(document.before).toBe('Before\n```ts\nunterminated\n```')
		expect(await report(taskId)).toMatchObject({ ok: true })
		expect(metadataOf(taskId).before).toBe('Before\n```ts\nunterminated\n```')
	})

	test('preserves indentation in human text', async () => {
		const taskId = String((await create()).taskId)
		const original = linear.issues.get(taskId)?.description ?? ''
		linear.edit(taskId, {
			description: `\n    indented code\n\n${original}\n\n    trailing code\n`,
		})
		await report(taskId)
		const document = metadataOf(taskId)
		expect(document.before).toBe('    indented code\n\nPaginate the customer list.')
		expect(document.after).toBe('    trailing code')
	})

	test('refuses text that would read as a second metadata block, however it is spelled', async () => {
		const forged = '{"kind": "limitless\\u002dtask", "version": 1}'
		expect(forged).not.toContain('limitless-task')
		const outcome = await failure('task_create', 'lead', LEAD, {
			title: 'Forged',
			summary: `Context:\n\n\`\`\`json\n${forged}\n\`\`\``,
		})
		expect(outcome.metadata).toMatchObject({ code: 'INVALID_INPUT' })
		expect(linear.events.filter((event) => event.startsWith('create:'))).toEqual([])
	})

	test('reports a created card Linear did not store as written', async () => {
		linear.storeDescription = (description) => description.replace('```json', '```json\n// note')
		const outcome = await failure('task_create', 'lead', LEAD, { title: 't', summary: 's' })
		expect(outcome.metadata).toMatchObject({ code: 'MALFORMED_TASK', taskId: taskIdsUsed() })
		expect(outcome.message).toContain('https://linear.app/example/issue/LIM-1')
		expect(outcome.message).toContain('do not create another card')
	})

	test('rejects the reserved marker and multi-line titles in model input', async () => {
		expect(
			await failure('task_create', 'lead', LEAD, { title: 'a\nb', summary: 'x' }),
		).toMatchObject({ metadata: { code: 'SCHEMA' } })
		expect(
			await failure('task_create', 'lead', LEAD, {
				title: 'Title',
				summary: `see ${ownerMarker(OTHER_LEAD)}`,
			}),
		).toMatchObject({ metadata: { code: 'SCHEMA' } })
		expect(linear.events).toEqual([])
	})

	test('rejects missing, duplicate, unknown-version, and mismatched metadata', async () => {
		const taskId = String((await create()).taskId)
		const original = linear.issues.get(taskId)?.description ?? ''
		const block = /```json\n([\s\S]*?)\n```/.exec(original)?.[1] ?? ''
		const variants = {
			missing: 'No metadata here.',
			duplicate: `${original}\n\n\`\`\`json\n${block}\n\`\`\``,
			version: original.replace('"version": 1', '"version": 2'),
			mismatch: original.replaceAll(taskId, '20000000-0000-4000-8000-000000000000'),
			owner: original.replace(
				`"owner": "${ownerMarker(LEAD)}"`,
				`"owner": "${ownerMarker(OTHER_LEAD)}"`,
			),
			invalid: original.replace('"blocked": false', '"blocked": "no"'),
		}
		for (const [name, description] of Object.entries(variants)) {
			linear.edit(taskId, { description })
			const outcome = await review(taskId, 'accept')
			expect(outcome, name).toMatchObject({ ok: false, metadata: { code: 'MALFORMED_TASK' } })
		}
		// Malformed cards still carrying this Lead's marker are flagged, not hidden.
		linear.edit(taskId, { description: variants.duplicate })
		expect(await list()).toMatchObject({
			tasks: [],
			unreadable: [{ identifier: 'LIM-1', problem: expect.stringContaining('more than one') }],
		})
		expect(stateOf(taskId)).toBe(config.states.in_progress)
	})

	test('flags manual workflow states, archived cards, and cards moved off the board', async () => {
		const unsupported = String((await create('Backlog')).taskId)
		linear.edit(unsupported, { stateId: backlogState })
		expect((await list()).tasks[0]).toMatchObject({ taskId: unsupported, status: 'unsupported' })
		expect(await review(unsupported, 'accept')).toMatchObject({
			ok: false,
			metadata: { code: 'UNSUPPORTED_STATE' },
		})
		expect(await report(unsupported)).toMatchObject({
			ok: false,
			metadata: { code: 'UNSUPPORTED_STATE' },
		})

		const archived = String((await create('Archived')).taskId)
		linear.edit(archived, { archived: true })
		expect((await list()).tasks.find((task) => task.taskId === archived)).toMatchObject({
			archived: true,
		})
		expect(await report(archived)).toMatchObject({ ok: false, metadata: { code: 'TASK_ARCHIVED' } })
		expect(await review(archived, 'cancel')).toMatchObject({
			ok: false,
			metadata: { code: 'TASK_ARCHIVED' },
		})

		const moved = String((await create('Moved')).taskId)
		linear.edit(moved, { projectId: '00000000-0000-4000-8000-0000000000ff' })
		expect(await review(moved, 'accept')).toMatchObject({
			ok: false,
			metadata: { code: 'TASK_OUTSIDE_BOARD' },
		})
		expect(await review('30000000-0000-4000-8000-000000000000', 'accept')).toMatchObject({
			ok: false,
			metadata: { code: 'TASK_NOT_FOUND' },
		})
	})

	test('filters by status', async () => {
		const open = String((await create('Open')).taskId)
		const closed = String((await create('Closed')).taskId)
		await review(closed, 'accept')
		expect((await list(LEAD, 'in_progress')).tasks.map((task) => task.taskId)).toEqual([open])
		expect((await list(LEAD, 'done')).tasks.map((task) => task.taskId)).toEqual([closed])
	})
})

describe('advisory failures', () => {
	test('a create Linear may have applied is never retried', async () => {
		linear.failures.push({
			method: 'createIssue',
			error: taskBoardError('OUTCOME_UNKNOWN', 'Linear did not confirm creating task.', {
				taskId: 'pending',
				outcomeUnknown: true,
			}),
		})
		const outcome = await failure('task_create', 'lead', LEAD, { title: 't', summary: 's' })
		expect(outcome.metadata).toMatchObject({ code: 'OUTCOME_UNKNOWN', outcomeUnknown: true })
		expect(outcome.message).toContain('native Unit dispatch, returns, and review continue')
		expect(linear.events.filter((event) => event.startsWith('create:'))).toHaveLength(1)
		expect(linear.events.some((event) => event.startsWith('read:'))).toBe(false)
	})

	test('a created card whose read-back fails keeps its taskId', async () => {
		linear.failures.push({
			method: 'readIssue',
			error: taskBoardError('TIMEOUT', 'Linear did not respond within 15 seconds.'),
		})
		const outcome = await failure('task_create', 'lead', LEAD, { title: 't', summary: 's' })
		const taskId = taskIdsUsed()
		expect(outcome.metadata).toMatchObject({ code: 'READBACK_FAILED', taskId })
		expect(outcome.message).toContain('do not create another card')
		expect(linear.issues.has(taskId)).toBe(true)
		expect((await list()).tasks.map((task) => task.taskId)).toEqual([taskId])
	})

	test('board verification failures stop writes before they start', async () => {
		const taskId = String((await create()).taskId)
		linear.failures.push({
			method: 'verifyBoard',
			error: taskBoardError('BOARD_MISCONFIGURED', 'The configured in_review state is missing.'),
		})
		expect(await report(taskId)).toMatchObject({
			ok: false,
			metadata: { code: 'BOARD_MISCONFIGURED' },
		})
		expect(stateOf(taskId)).toBe(config.states.in_progress)
	})

	test('a confirmed update whose verification read fails still succeeds', async () => {
		const taskId = String((await create()).taskId)
		linear.afterUpdate = () => {
			linear.failures.push({ method: 'readIssue', error: taskBoardError('TIMEOUT', 'slow') })
		}
		expect(await report(taskId)).toMatchObject({ ok: true })
	})
})

describe('concurrency', () => {
	test('cooperating writes to one card in this process are serialized', async () => {
		const taskId = String((await create()).taskId)
		linear.events.length = 0
		const [reported, accepted] = await Promise.all([report(taskId), review(taskId, 'accept')])
		expect(reported).toMatchObject({ ok: true })
		expect(accepted).toMatchObject({ ok: true, output: { status: 'done' } })
		const writes = linear.events.filter((event) => /^(read|update):/u.test(event))
		expect(writes).toEqual([
			`read:${taskId}`,
			`update:${taskId}`,
			`read:${taskId}`,
			`read:${taskId}`,
			`update:${taskId}`,
			`read:${taskId}`,
		])
		// The second write re-read the first; nothing was lost.
		expect(metadataOf(taskId).metadata).toMatchObject({
			unit: { sessionID: UNIT },
			report: { result: 'ready' },
			review: { decision: 'accept' },
		})
	})

	test.each([
		['a state change', { stateId: config.states.canceled }],
		['a move off the board', { projectId: '00000000-0000-4000-8000-0000000000ff' }],
		['archival', { archived: true }],
	])('an interleaved %s from elsewhere is reported, not hidden', async (_name, change) => {
		const taskId = String((await create()).taskId)
		linear.afterUpdate = (id) => linear.edit(id, change)
		expect(await report(taskId)).toMatchObject({
			ok: false,
			metadata: { code: 'CONCURRENT_CHANGE', taskId },
		})
	})

	test('a card deleted right after a write is reported', async () => {
		const taskId = String((await create()).taskId)
		linear.afterUpdate = (id) => linear.issues.delete(id)
		expect(await report(taskId)).toMatchObject({
			ok: false,
			metadata: { code: 'CONCURRENT_CHANGE', taskId },
		})
	})
})

describe('workflow guidance', () => {
	test('appears only for the role that can use its tools', () => {
		const tools = { task_create: {}, task_list: {}, task_review: {} }
		expect(taskBoardGuidance({ agent: Agent.ID.make('lead'), tools: tools as never })).toBe(
			LEAD_TASK_BOARD_GUIDANCE,
		)
		expect(taskBoardGuidance({ agent: Agent.ID.make('lead'), tools: {} })).toBeUndefined()
		expect(taskBoardGuidance({ agent: Agent.ID.make('limitless'), tools: tools as never })).toBe(
			undefined,
		)
		expect(
			taskBoardGuidance({ agent: Agent.ID.make('unit'), tools: { task_report: {} } as never }),
		).toContain('task_report')
		expect(
			taskBoardGuidance({ agent: Agent.ID.make('research'), tools: { task_report: {} } as never }),
		).toBeUndefined()
	})
})

function taskIdsUsed(): string {
	const created = linear.events.find((event) => event.startsWith('create:'))
	if (created === undefined) throw new Error('nothing created')
	return created.slice('create:'.length)
}
