import { Deferred, Effect, Fiber, Queue, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { expect, test } from 'vitest'
import { Scheduler } from '../scheduler'
import { Tasks } from '../tasks/service'
import { TaskStore } from '../tasks/store'
import { WorkerError } from '../worker/schema'
import { coordinator, review, settings, worker } from './fixtures'

test('occupied capacity does not probe readiness or feed helper events back into scheduling', async () => {
	const { runtime, control, changes } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const store = yield* TaskStore
				const scheduler = yield* Scheduler
				yield* tasks.submit('first', review())
				yield* scheduler.tick()
				expect(control.readinessCalls).toBe(1)
				yield* TestClock.adjust(1)
				const queued = yield* tasks.submit('queued', review(2))
				control.readinessNotifies = true
				const updates = yield* store.subscribeUpdates
				yield* scheduler.run.pipe(Effect.forkScoped)
				yield* Stream.fromSubscription(updates).pipe(Stream.take(2), Stream.runDrain)
				expect(control.readinessCalls).toBe(1)
				const waiting = yield* store.getCommand(queued.task.id, queued.command.id)
				expect(waiting.task.placement._tag).toBe('Unassigned')
				expect(waiting.command.delivery._tag).toBe('Pending')

				control.observation = { _tag: 'Idle' }
				const views = yield* tasks.events(queued.task.id, queued.command.id)
				yield* Queue.offer(changes, undefined)
				const dispatched = yield* views.pipe(
					Stream.filter((view) => view.command.delivery._tag === 'Acknowledged'),
					Stream.runHead,
				)
				expect(dispatched._tag).toBe('Some')
				expect(control.readinessCalls).toBe(2)
			}).pipe(Effect.scoped),
		)
	} finally {
		await runtime.dispose()
	}
})

test('resume routes a new message to the pinned worker, directory and existing session', async () => {
	const { runtime, calls } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const scheduler = yield* Scheduler
				const initial = yield* tasks.submit('review', review())
				yield* scheduler.tick()
				const reviewed = yield* tasks.getCommand(initial.task.id, initial.command.id)
				expect(reviewed.command.delivery).toEqual({
					_tag: 'Acknowledged',
					nativeRef: {
						sessionId: `ses_pipeline${initial.task.id.replaceAll('-', '')}`,
						messageId: initial.command.messageId,
					},
				})
				expect(reviewed.task.placement).toMatchObject({
					_tag: 'Assigned',
					assignment: {
						workerId: worker.id,
						directory: `${worker.workspaceRoot}/${initial.task.id}/checkout`,
					},
				})

				const resumed = yield* tasks.resume(initial.task.id, 'resume', {
					afterCommandId: initial.command.id,
					message: 'Please check again.',
				})
				yield* scheduler.tick()
				const view = yield* tasks.getCommand(initial.task.id, resumed.command.id)
				expect(view.command.delivery._tag).toBe('Acknowledged')
				expect(view.task.placement).toEqual(reviewed.task.placement)
			}),
		)
		expect(calls.map((call) => call.operation).filter((op) => op !== 'observe')).toEqual([
			'prepare',
			'createSession',
			'admit',
			'requireSession',
			'admit',
		])
		const admits = calls.filter((call) => call.operation === 'admit')
		expect(admits[0]?.session).toEqual(admits[1]?.session)
		expect(admits[0]?.messageId).not.toBe(admits[1]?.messageId)
	} finally {
		await runtime.dispose()
	}
})

test('resume never replaces a missing native session', async () => {
	const { runtime, calls, sessions } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const scheduler = yield* Scheduler
				const initial = yield* tasks.submit('review', review())
				yield* scheduler.tick()
				sessions.clear()
				const resumed = yield* tasks.resume(initial.task.id, 'resume', {
					afterCommandId: initial.command.id,
					message: 'Continue.',
				})
				yield* scheduler.tick()
				const view = yield* tasks.getCommand(initial.task.id, resumed.command.id)
				expect(view.command.delivery).toMatchObject({
					_tag: 'Rejected',
					reason: { code: 'session_unavailable' },
				})
			}),
		)
		expect(calls.filter((call) => call.operation === 'createSession')).toHaveLength(1)
		expect(calls.filter((call) => call.operation === 'admit')).toHaveLength(1)
	} finally {
		await runtime.dispose()
	}
})

test('a lost native reply is confirmed only by the exact admitted message and never resent', async () => {
	const { runtime, calls, control } = coordinator()
	control.loseAdmitReply = true
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const { task, command } = yield* tasks.submit('review', review())
				yield* (yield* Scheduler).tick()
				const view = yield* tasks.getCommand(task.id, command.id)
				expect(view.command.delivery).toMatchObject({
					_tag: 'Acknowledged',
					nativeRef: { messageId: command.messageId },
				})
			}),
		)
		expect(calls.filter((call) => call.operation === 'admit')).toHaveLength(1)
		expect(calls.filter((call) => call.operation === 'findAdmission')).toHaveLength(1)
	} finally {
		await runtime.dispose()
	}
})

test('idle native history neither clears an unconfirmed delivery nor releases its capacity', async () => {
	const { runtime, calls, control } = coordinator()
	control.dropAdmit = true
	control.observation = { _tag: 'Idle' }
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const scheduler = yield* Scheduler
				const first = yield* tasks.submit('first', review(1))
				yield* scheduler.tick()
				const second = yield* tasks.submit('second', review(2))
				for (let tick = 0; tick < 3; tick++) yield* scheduler.tick()

				const uncertain = yield* tasks.getCommand(first.task.id, first.command.id)
				expect(uncertain.command.delivery).toEqual({ _tag: 'Unconfirmed' })
				const queued = yield* tasks.getCommand(second.task.id, second.command.id)
				expect(queued.command.delivery).toEqual({ _tag: 'Pending', step: 'checkout' })
				expect(queued.task.placement._tag).toBe('Unassigned')
			}),
		)
		expect(calls.filter((call) => call.operation === 'admit')).toHaveLength(1)
	} finally {
		await runtime.dispose()
	}
})

test('a lost interrupt reply stays unconfirmed and is never retried', async () => {
	const { runtime, calls, control } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const scheduler = yield* Scheduler
				const { task, command } = yield* tasks.submit('review', review())
				yield* scheduler.tick()
				control.loseInterruptReply = true
				const interrupt = yield* tasks.interrupt(task.id, 'interrupt', {
					afterCommandId: command.id,
				})
				yield* scheduler.tick()
				control.loseInterruptReply = false
				yield* scheduler.tick()
				const view = yield* tasks.getCommand(task.id, interrupt.command.id)
				expect(view.command.delivery).toEqual({ _tag: 'Unconfirmed' })
			}),
		)
		expect(calls.filter((call) => call.operation === 'interrupt')).toHaveLength(1)
	} finally {
		await runtime.dispose()
	}
})

test('advisory capacity passes to the next task only after the native session is observed idle', async () => {
	const { runtime, control } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const scheduler = yield* Scheduler
				const store = yield* TaskStore
				const first = yield* tasks.submit('first', review(1))
				yield* TestClock.adjust(1)
				const second = yield* tasks.submit('second', review(2))
				yield* scheduler.tick()
				expect(yield* store.hasLease(first.task.id)).toBe(true)
				expect(
					(yield* tasks.getCommand(second.task.id, second.command.id)).task.placement._tag,
				).toBe('Unassigned')

				control.observation = { _tag: 'NeedsInput', permissionIds: ['per_1'], formIds: [] }
				yield* scheduler.tick()
				expect(yield* store.hasLease(first.task.id)).toBe(true)

				control.observation = { _tag: 'Idle' }
				yield* scheduler.tick()
				yield* scheduler.tick()
				expect(yield* store.hasLease(first.task.id)).toBe(false)
				const placed = yield* tasks.getCommand(second.task.id, second.command.id)
				expect(placed.command.delivery._tag).toBe('Acknowledged')
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test('a command that cannot be placed before the queue timeout is rejected without being sent', async () => {
	const { runtime, calls, control } = coordinator()
	control.unreachable = true
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const scheduler = yield* Scheduler
				const { task, command } = yield* tasks.submit('review', review())
				yield* scheduler.tick()
				expect((yield* tasks.getCommand(task.id, command.id)).command.delivery._tag).toBe('Pending')
				yield* TestClock.adjust(settings.queueTimeoutMs)
				control.unreachable = false
				yield* scheduler.tick()
				const view = yield* tasks.getCommand(task.id, command.id)
				expect(view.command.delivery).toMatchObject({
					_tag: 'Rejected',
					reason: { code: 'queue_timeout' },
				})
			}),
		)
		expect(calls.some((call) => call.operation === 'admit')).toBe(false)
	} finally {
		await runtime.dispose()
	}
})

test('preparation failures reject the command; transient outages leave it pending', async () => {
	const { runtime, control } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const scheduler = yield* Scheduler
				const { task, command } = yield* tasks.submit('review', review())
				control.prepareError = WorkerError.make({ code: 'unavailable', message: 'Busy' })
				yield* scheduler.tick()
				expect((yield* tasks.getCommand(task.id, command.id)).command.delivery).toEqual({
					_tag: 'Pending',
					step: 'checkout',
				})
				control.prepareError = WorkerError.make({ code: 'workspace', message: 'Clone failed' })
				yield* scheduler.tick()
				expect((yield* tasks.getCommand(task.id, command.id)).command.delivery).toMatchObject({
					_tag: 'Rejected',
					reason: { code: 'preparation_failed', message: 'Clone failed' },
				})
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test('command events follow delivery to a settled native observation; cancelling a wait has no effect on the task', async () => {
	const { runtime, calls, control } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const scheduler = yield* Scheduler
				const { task, command } = yield* tasks.submit('review', review())

				const subscribe = Effect.fn('Test.subscribe')(function* () {
					const views = yield* tasks.events(task.id, command.id)
					const subscribed = yield* Deferred.make<void>()
					const fiber = yield* views.pipe(
						Stream.tap(() => Deferred.succeed(subscribed, undefined)),
						Stream.runCollect,
						Effect.forkChild,
					)
					yield* Deferred.await(subscribed)
					return fiber
				})
				const abandoned = yield* subscribe()
				const collected = yield* subscribe()
				yield* Fiber.interrupt(abandoned)

				yield* scheduler.tick()
				control.observation = { _tag: 'Idle' }
				yield* scheduler.tick()
				const views = yield* Fiber.join(collected)
				expect(views.map((view) => view.command.delivery._tag)).toContain('Pending')
				expect(views.at(-1)?.command.delivery._tag).toBe('Acknowledged')
				expect(views.at(-1)?.observation).toEqual({ _tag: 'Idle' })
				expect(
					JSON.stringify(views).includes('runId') || JSON.stringify(views).includes('result'),
				).toBe(false)
			}),
		)
		expect(calls.some((call) => call.operation === 'interrupt')).toBe(false)
	} finally {
		await runtime.dispose()
	}
})
