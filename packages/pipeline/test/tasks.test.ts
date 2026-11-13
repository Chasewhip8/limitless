import { Deferred, Effect, Fiber, Logger } from 'effect'
import { TestClock } from 'effect/testing'
import { expect, test } from 'vitest'
import { Scheduler } from '../scheduler'
import { continuePrompt } from '../tasks/prompt'
import { Tasks } from '../tasks/service'
import { TaskStore } from '../tasks/store'
import { type NativeObservation, type NativeResult, WorkerError } from '../worker/schema'
import { nativeEvaluationBudgetMs } from '../workflow'
import { coordinator, review } from './fixtures'

const completed: NativeResult = {
	_tag: 'Completed',
	message: { id: 'msg_final', text: 'Final review.' },
}

test('temporary native read failures recover without admitting another prompt', async () => {
	const { runtime, control, calls } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const first = yield* tasks.review(review())
				yield* (yield* Scheduler).tick()
				control.resultErrors.push(WorkerError.make({ code: 'unavailable', message: 'Timeout' }))
				control.result = completed
				const pending = yield* tasks.get(first.operation).pipe(Effect.forkChild)
				yield* Deferred.await(control.resultStarted)
				yield* TestClock.adjust('2 seconds')
				expect((yield* Fiber.join(pending)).state).toEqual(completed)
				expect(calls.filter((call) => call.operation === 'result')).toHaveLength(2)
				expect(calls.filter((call) => call.operation === 'admit')).toHaveLength(1)
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test.each([
	'protocol',
	'ownership',
	'incompatible',
] as const)('permanent %s failures return immediately without exposing raw messages', async (code) => {
	const { runtime, control, calls } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const first = yield* tasks.review(review())
				yield* (yield* Scheduler).tick()
				control.resultErrors.push(WorkerError.make({ code, message: 'private response body' }))
				const view = yield* tasks.get(first.operation)
				expect(view.state).toMatchObject({
					_tag: 'Unavailable',
					message: expect.stringContaining(code),
				})
				expect(JSON.stringify(view)).not.toContain('private response body')
				expect(calls.filter((call) => call.operation === 'result')).toHaveLength(1)
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test('persistent native read failures exhaust the retry window without submitting work', async () => {
	const { runtime, control, calls } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const first = yield* tasks.review(review())
				yield* (yield* Scheduler).tick()
				control.resultErrors.push(
					...Array.from({ length: 100 }, () =>
						WorkerError.make({ code: 'unavailable', message: 'Timeout' }),
					),
				)
				const pending = yield* tasks.get(first.operation).pipe(Effect.forkChild)
				yield* Deferred.await(control.resultStarted)
				yield* TestClock.adjust('2 minutes')
				expect((yield* Fiber.join(pending)).state).toMatchObject({ _tag: 'Unavailable' })
				expect(calls.filter((call) => call.operation === 'result')).toHaveLength(61)
				expect(calls.filter((call) => call.operation === 'admit')).toHaveLength(1)
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test('ambiguous native history is returned unchanged without retrying', async () => {
	const { runtime, control, calls } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const first = yield* tasks.review(review())
				yield* (yield* Scheduler).tick()
				control.result = { _tag: 'Unavailable', message: 'Unattributed native history' }
				expect((yield* tasks.get(first.operation)).state).toEqual(control.result)
				expect(calls.filter((call) => call.operation === 'result')).toHaveLength(1)
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test('cancelling a native read during backoff prevents further retries without interrupting the reviewer', async () => {
	const { runtime, control, calls } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const first = yield* tasks.review(review())
				yield* (yield* Scheduler).tick()
				control.resultErrors.push(WorkerError.make({ code: 'unavailable', message: 'Timeout' }))
				const pending = yield* tasks.get(first.operation).pipe(Effect.forkChild)
				yield* Deferred.await(control.resultStarted)
				yield* TestClock.adjust('1 second')
				yield* Fiber.interrupt(pending)
				yield* TestClock.adjust('2 minutes')
				expect(calls.filter((call) => call.operation === 'result')).toHaveLength(1)
				expect(calls.some((call) => call.operation === 'interrupt')).toBe(false)
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test('temporary observation failures recover the live input request without submitting work', async () => {
	const { runtime, control, calls } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const first = yield* tasks.review(review())
				yield* (yield* Scheduler).tick()
				control.observationErrors.push(
					WorkerError.make({ code: 'unavailable', message: 'Timeout' }),
				)
				control.observation = { _tag: 'NeedsInput', permissionIds: ['per_1'], formIds: [] }
				const pending = yield* tasks.get(first.operation).pipe(Effect.forkChild)
				yield* Deferred.await(control.resultStarted)
				yield* TestClock.adjust('2 seconds')
				expect((yield* Fiber.join(pending)).state).toEqual({
					_tag: 'NeedsInput',
					permissions: 1,
					forms: 0,
				})
				expect(calls.filter((call) => call.operation === 'result')).toHaveLength(2)
				expect(calls.filter((call) => call.operation === 'admit')).toHaveLength(1)
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test('a slow failure and hanging retry share the original evaluation deadline', async () => {
	const { runtime, control, calls } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const first = yield* tasks.review(review())
				yield* (yield* Scheduler).tick()
				control.resultDelayMs = 15_000
				control.resultErrors.push(WorkerError.make({ code: 'unavailable', message: 'Timeout' }))
				control.resultGate = yield* Deferred.make<void>()
				const pending = yield* tasks.get(first.operation).pipe(Effect.forkChild)
				yield* Deferred.await(control.resultStarted)
				yield* TestClock.adjust(nativeEvaluationBudgetMs)
				expect((yield* Fiber.join(pending)).state).toMatchObject({
					_tag: 'Unavailable',
					message: expect.stringContaining('three-minute budget'),
				})
				expect(calls.filter((call) => call.operation === 'result')).toHaveLength(2)
				expect(control.resultsInterrupted).toBe(1)
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test('a two-minute history timeout still gets a retry within the original evaluation budget', async () => {
	const { runtime, control, calls } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const first = yield* tasks.review(review())
				yield* (yield* Scheduler).tick()
				control.resultDelayMs = 120_000
				control.resultErrors.push(
					WorkerError.make({ code: 'unavailable', message: 'History timeout' }),
				)
				control.result = completed
				const pending = yield* tasks.get(first.operation).pipe(Effect.forkChild)
				yield* Deferred.await(control.resultStarted)
				yield* TestClock.adjust('2 minutes')
				control.resultDelayMs = 0
				yield* TestClock.adjust('2 seconds')
				expect((yield* Fiber.join(pending)).state).toEqual(completed)
				expect(calls.filter((call) => call.operation === 'result')).toHaveLength(2)
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test('native read diagnostics retain the stage and HTTP status without leaking upstream text', async () => {
	const { runtime, control } = coordinator()
	const logs: unknown[] = []
	const logger = Logger.layer([Logger.make(({ message }) => logs.push(message))])
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const first = yield* tasks.review(review())
				yield* (yield* Scheduler).tick()
				control.resultErrors.push(
					WorkerError.make({
						code: 'protocol',
						reason: 'http_status',
						stage: 'history',
						status: 401,
						message: 'private credential or native response content',
					}),
				)
				const view = yield* tasks.get(first.operation).pipe(Effect.provide(logger))
				expect(view.state).toMatchObject({
					_tag: 'Unavailable',
					message: expect.stringContaining('history: http_status, HTTP 401'),
				})
				expect(JSON.stringify(logs)).toContain(first.operation)
				expect(JSON.stringify(logs)).toContain('http_status')
				expect(JSON.stringify({ view, logs })).not.toContain('private credential')
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test.each([
	'continue',
	'restart',
] as const)('%s bounds and cancels readonly readiness without admitting duplicate work', async (action) => {
	const { runtime, control } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const store = yield* TaskStore
				const first = yield* tasks.review(review())
				yield* (yield* Scheduler).tick()
				control.result = completed
				control.observation = { _tag: 'Idle' }
				const start = Effect.fn('Test.startReadiness')(function* () {
					control.resultGate = yield* Deferred.make<void>()
					control.resultStarted = yield* Deferred.make<void>()
					const fiber = yield* tasks[action](first.operation).pipe(Effect.forkChild)
					yield* Deferred.await(control.resultStarted)
					return fiber
				})
				const cancelled = yield* start()
				yield* Fiber.interrupt(cancelled)
				expect(control.resultsInterrupted).toBe(1)
				expect(
					yield* store.findAction(action === 'continue' ? 'resume' : 'restart', first.operation),
				).toBeUndefined()
				const timedOut = yield* start()
				yield* TestClock.adjust(nativeEvaluationBudgetMs)
				expect(yield* Fiber.join(timedOut).pipe(Effect.flip)).toMatchObject({
					code: 'observation_timeout',
				})
				expect(control.resultsInterrupted).toBe(2)
				expect(
					yield* store.findAction(action === 'continue' ? 'resume' : 'restart', first.operation),
				).toBeUndefined()
				const slow = yield* start()
				yield* TestClock.adjust(11_000)
				if (control.resultGate === null) throw new Error('Missing readiness gate')
				yield* Deferred.succeed(control.resultGate, undefined)
				const accepted = yield* Fiber.join(slow)
				control.unreachable = true
				control.githubUnavailable = true
				expect(yield* tasks[action](first.operation)).toEqual(accepted)
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test('slow result evaluation returns unavailable within the coordinator budget and cancels its read', async () => {
	const { runtime, control } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const first = yield* tasks.review(review())
				yield* (yield* Scheduler).tick()
				control.resultGate = yield* Deferred.make<void>()
				const pending = yield* tasks.get(first.operation).pipe(Effect.forkChild)
				yield* Deferred.await(control.resultStarted)
				yield* TestClock.adjust(nativeEvaluationBudgetMs)
				const view = yield* Fiber.join(pending)
				expect(view.state).toMatchObject({
					_tag: 'Unavailable',
					message: expect.stringContaining('three-minute budget'),
				})
				expect(control.resultsInterrupted).toBe(1)
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test('review recovers a closed PR before testing fresh-checkout eligibility', async () => {
	const { runtime, control } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const first = yield* tasks.review(review())
				control.githubClosed = true
				expect(yield* tasks.review(review())).toEqual(first)
				yield* (yield* Scheduler).tick()
				control.result = completed
				control.observation = { _tag: 'Idle' }
				expect(yield* tasks.review(review(2)).pipe(Effect.flip)).toMatchObject({
					_tag: 'PullRequestUnavailable',
				})
				expect(yield* tasks.restart(first.operation).pipe(Effect.flip)).toMatchObject({
					_tag: 'PullRequestUnavailable',
				})
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test('continuation requires settled native evidence, session idleness and a ready retained placement', async () => {
	const { runtime, control } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const first = yield* tasks.review(review())
				expect(yield* tasks.continue(first.operation).pipe(Effect.flip)).toMatchObject({
					code: 'operation_pending',
				})
				yield* (yield* Scheduler).tick()
				for (const result of [
					{ _tag: 'Pending' },
					{ _tag: 'Unavailable', message: 'Ambiguous native history' },
				] satisfies NativeResult[]) {
					control.result = result
					control.observation = { _tag: 'Idle' }
					expect(yield* tasks.continue(first.operation).pipe(Effect.flip)).toMatchObject({
						code: 'native_unsettled',
					})
					expect(yield* tasks.restart(first.operation).pipe(Effect.flip)).toMatchObject({
						code: 'native_unsettled',
					})
				}
				control.result = completed
				for (const observation of [
					{ _tag: 'Running', backgroundJobs: 1 },
					{ _tag: 'NeedsInput', permissionIds: ['per_test'], formIds: [] },
					{ _tag: 'Unavailable', message: 'Native session unreadable' },
				] satisfies NativeObservation[]) {
					control.observation = observation
					expect(yield* tasks.continue(first.operation).pipe(Effect.flip)).toMatchObject({
						code: 'native_unsettled',
					})
				}
				control.observation = { _tag: 'Idle' }
				control.placement = { capsulePhase: 'stopped', workspaceState: 'bound' }
				expect(yield* tasks.continue(first.operation).pipe(Effect.flip)).toMatchObject({
					code: 'session_unavailable',
				})
				control.placement = { capsulePhase: 'ready', workspaceState: 'bound' }
				control.result = {
					_tag: 'Failed',
					error: { type: 'provider.auth', message: 'Authentication required' },
				}
				const next = yield* tasks.continue(first.operation)
				const stored = yield* (yield* TaskStore).getOperation(next.operation)
				expect(stored.command.delivery).toMatchObject({
					_tag: 'Pending',
					payload: { _tag: 'Resume', prompt: continuePrompt(first.pr) },
				})
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test('concurrent callers share one continuation and recover it after later progress and remote outages', async () => {
	const { runtime, control } = coordinator()
	try {
		const tasks = await runtime.runPromise(Tasks)
		const scheduler = await runtime.runPromise(Scheduler)
		const first = await runtime.runPromise(tasks.review(review()))
		await runtime.runPromise(scheduler.tick())
		control.observation = { _tag: 'Idle' }
		control.result = completed
		const successors = await Promise.all(
			Array.from({ length: 8 }, () => runtime.runPromise(tasks.continue(first.operation))),
		)
		expect(new Set(successors.map((item) => item.operation)).size).toBe(1)
		const next = successors[0]
		if (next === undefined) throw new Error('Missing continuation')
		await runtime.runPromise(scheduler.tick())
		const fresh = await runtime.runPromise(tasks.restart(next.operation))
		control.unreachable = true
		control.githubUnavailable = true
		expect(await runtime.runPromise(tasks.continue(first.operation))).toEqual({
			...next,
			closed: true,
		})
		expect(await runtime.runPromise(tasks.restart(next.operation))).toEqual(fresh)
	} finally {
		await runtime.dispose()
	}
})

test('interrupts never start unsent work or become the current review operation', async () => {
	const { runtime, calls } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const scheduler = yield* Scheduler
				const first = yield* tasks.review(review())
				expect(yield* tasks.interrupt(first.operation)).toEqual({ ...first, status: 'NotStarted' })
				expect(calls.some((call) => call.operation === 'interrupt')).toBe(false)
				yield* scheduler.tick()
				expect(yield* tasks.interrupt(first.operation)).toEqual({
					...first,
					status: 'Requested',
				})
				yield* scheduler.tick()
				expect(yield* tasks.interrupt(first.operation)).toEqual({
					...first,
					status: 'Acknowledged',
				})
				expect(yield* tasks.review(review())).toEqual(first)
				expect(calls.filter((call) => call.operation === 'interrupt')).toHaveLength(1)
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test('historical native results precede session activity while unresolved operations expose native input', async () => {
	const { runtime, control } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const first = yield* tasks.review(review())
				yield* (yield* Scheduler).tick()
				control.observation = { _tag: 'NeedsInput', permissionIds: ['per_1'], formIds: ['frm_1'] }
				expect((yield* tasks.get(first.operation)).state).toEqual({
					_tag: 'NeedsInput',
					permissions: 1,
					forms: 1,
				})
				control.result = completed
				expect((yield* tasks.get(first.operation)).state).toEqual(completed)
			}),
		)
	} finally {
		await runtime.dispose()
	}
})
