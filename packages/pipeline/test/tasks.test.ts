import { Deferred, Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { expect, test } from 'vitest'
import { Scheduler } from '../scheduler'
import { continuePrompt } from '../tasks/prompt'
import { Tasks } from '../tasks/service'
import { TaskStore } from '../tasks/store'
import type { NativeObservation, NativeResult } from '../worker/schema'
import { nativeEvaluationBudgetMs } from '../workflow'
import { coordinator, review } from './fixtures'

const completed: NativeResult = {
	_tag: 'Completed',
	message: { id: 'msg_final', text: 'Final review.' },
}

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
				control.unreachable = true
				expect((yield* tasks.get(first.operation)).state._tag).toBe('Unavailable')
			}),
		)
	} finally {
		await runtime.dispose()
	}
})
