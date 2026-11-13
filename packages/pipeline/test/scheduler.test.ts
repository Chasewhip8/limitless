import type { SessionPlacement } from '@limitless/capsule/rpc'
import { Deferred, Effect, Fiber, Queue, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { expect, test } from 'vitest'
import { Scheduler } from '../scheduler'
import type { StoredCommand } from '../tasks/command'
import { continuePrompt } from '../tasks/prompt'
import { Tasks } from '../tasks/service'
import { TaskStore } from '../tasks/store'
import { WorkerError } from '../worker/schema'
import type { OperationView } from '../workflow'
import { coordinator, host, review, settings, worker } from './fixtures'

type Control = ReturnType<typeof coordinator>['control']

/** A continuation is accepted only after its predecessor's native result settles and the session is idle. */
function settleNative(control: Control) {
	control.result = { _tag: 'Completed', message: { id: 'msg_final', text: 'Done' } }
	control.observation = { _tag: 'Idle' }
}

/** Subscribes before the first read, so a delivery committed at any point is observed. */
const awaitAcknowledged = Effect.fn('Test.awaitAcknowledged')(function* <E>(
	read: Effect.Effect<{ readonly command: StoredCommand } | undefined, E>,
) {
	const store = yield* TaskStore
	const updates = yield* store.subscribeUpdates
	return yield* Stream.make(undefined).pipe(
		Stream.concat(Stream.fromSubscription(updates)),
		Stream.mapEffect(() => read),
		Stream.filter((stored) => stored?.command.delivery._tag === 'Acknowledged'),
		Stream.runHead,
	)
})

test('occupied capacity does not probe readiness or feed readiness events back into scheduling', async () => {
	const { runtime, control, changes } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const store = yield* TaskStore
				const scheduler = yield* Scheduler
				yield* tasks.review(review())
				yield* scheduler.tick()
				expect(control.readinessCalls).toBe(1)
				yield* TestClock.adjust(1)
				const queued = yield* tasks.review(review(2))
				control.readinessNotifies = true
				const updates = yield* store.subscribeUpdates
				yield* scheduler.run.pipe(Effect.forkScoped)
				yield* Stream.fromSubscription(updates).pipe(Stream.take(2), Stream.runDrain)
				expect(control.readinessCalls).toBe(1)
				const waiting = yield* store.getOperation(queued.operation)
				expect(waiting.task.placement._tag).toBe('Unassigned')
				expect(waiting.command.delivery._tag).toBe('Pending')

				control.observation = { _tag: 'Idle' }
				yield* Queue.offer(changes, undefined)
				const dispatched = yield* awaitAcknowledged(store.getOperation(queued.operation))
				expect(dispatched._tag).toBe('Some')
				expect(control.readinessCalls).toBe(2)
			}).pipe(Effect.scoped),
		)
	} finally {
		await runtime.dispose()
	}
})

test('continue sends the fixed prompt to the pinned worker, Capsule placement and existing session', async () => {
	const { runtime, calls, control, inbox } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const store = yield* TaskStore
				const scheduler = yield* Scheduler
				const initial = yield* tasks.review(review())
				yield* scheduler.tick()
				const reviewed = yield* store.getOperation(initial.operation)
				const id = reviewed.task.id.replaceAll('-', '')
				expect(reviewed.command.delivery).toEqual({
					_tag: 'Acknowledged',
					nativeRef: { sessionId: `ses_pipeline${id}`, messageId: reviewed.command.messageId },
				})
				expect(reviewed.task.placement).toEqual({
					_tag: 'Assigned',
					assignment: {
						workerId: worker.id,
						workerUrl: worker.url,
						controlDirectory: worker.controlDirectory,
						storageId: host.storageId,
						workspaceId: `wrk_pipeline${id}`,
						sessionId: `ses_pipeline${id}`,
						directory: `${host.checkoutRoot}/wrk_pipeline${id}/checkout`,
					},
				})

				settleNative(control)
				const continued = yield* tasks.continue(initial.operation)
				expect(yield* tasks.continue(initial.operation)).toEqual(continued)
				yield* scheduler.tick()
				const view = yield* store.getOperation(continued.operation)
				expect(view.command.delivery._tag).toBe('Acknowledged')
				expect(view.task.placement).toEqual(reviewed.task.placement)
				expect(inbox.get(view.command.messageId ?? '')).toBe(continuePrompt(initial.pr))
			}),
		)
		expect(
			calls
				.map((call) => call.operation)
				.filter((op) => ['prepareSession', 'requirePlacement', 'admit'].includes(op)),
		).toEqual([
			'prepareSession',
			'requirePlacement',
			'admit',
			// The settlement check at acceptance, then the dispatch check before sending.
			'requirePlacement',
			'requirePlacement',
			'admit',
		])
		const admits = calls.filter((call) => call.operation === 'admit')
		expect(admits[0]?.session).toEqual(admits[1]?.session)
		expect(admits[0]?.messageId).not.toBe(admits[1]?.messageId)
	} finally {
		await runtime.dispose()
	}
})

test('continuation fails before enqueue and never replaces a missing native session', async () => {
	const { runtime, calls, control, sessions } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const store = yield* TaskStore
				const scheduler = yield* Scheduler
				const { operation } = yield* tasks.review(review())
				yield* scheduler.tick()
				settleNative(control)
				sessions.clear()
				const error = yield* tasks.continue(operation).pipe(Effect.flip)
				expect(error).toMatchObject({ _tag: 'TaskConflict', code: 'session_unavailable' })
				expect(yield* store.findAction('resume', operation)).toBeUndefined()
				yield* scheduler.tick()
			}),
		)
		expect(calls.filter((call) => call.operation === 'prepareSession')).toHaveLength(1)
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
				const store = yield* TaskStore
				const { operation } = yield* tasks.review(review())
				yield* (yield* Scheduler).tick()
				const { command } = yield* store.getOperation(operation)
				expect(command.delivery).toMatchObject({
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
				const store = yield* TaskStore
				const scheduler = yield* Scheduler
				const first = yield* tasks.review(review(1))
				yield* scheduler.tick()
				const second = yield* tasks.review(review(2))
				for (let tick = 0; tick < 3; tick++) yield* scheduler.tick()

				const uncertain = yield* store.getOperation(first.operation)
				expect(uncertain.command.delivery._tag).toBe('Unconfirmed')
				const queued = yield* store.getOperation(second.operation)
				expect(queued.command.delivery).toMatchObject({ _tag: 'Pending', step: 'session' })
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
				const store = yield* TaskStore
				const scheduler = yield* Scheduler
				const { operation } = yield* tasks.review(review())
				yield* scheduler.tick()
				control.loseInterruptReply = true
				expect((yield* tasks.interrupt(operation)).status).toBe('Requested')
				yield* scheduler.tick()
				control.loseInterruptReply = false
				yield* scheduler.tick()
				expect((yield* tasks.interrupt(operation)).status).toBe('DeliveryUnconfirmed')
				yield* scheduler.tick()
				const stop = yield* store.findAction('interrupt', operation)
				expect(stop?.command.delivery._tag).toBe('Unconfirmed')
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
				const first = yield* tasks.review(review(1))
				yield* TestClock.adjust(1)
				const second = yield* tasks.review(review(2))
				yield* scheduler.tick()
				const running = yield* store.getOperation(first.operation)
				expect(yield* store.hasLease(running.task.id)).toBe(true)
				expect((yield* store.getOperation(second.operation)).task.placement._tag).toBe('Unassigned')

				control.observation = { _tag: 'NeedsInput', permissionIds: ['per_1'], formIds: [] }
				yield* scheduler.tick()
				expect(yield* store.hasLease(running.task.id)).toBe(true)

				control.observation = { _tag: 'Idle' }
				yield* scheduler.tick()
				yield* scheduler.tick()
				expect(yield* store.hasLease(running.task.id)).toBe(false)
				const placed = yield* store.getOperation(second.operation)
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
				const store = yield* TaskStore
				const scheduler = yield* Scheduler
				const { operation } = yield* tasks.review(review())
				yield* scheduler.tick()
				expect((yield* store.getOperation(operation)).command.delivery._tag).toBe('Pending')
				yield* TestClock.adjust(settings.queueTimeoutMs)
				control.unreachable = false
				yield* scheduler.tick()
				expect((yield* store.getOperation(operation)).command.delivery).toMatchObject({
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
				const store = yield* TaskStore
				const scheduler = yield* Scheduler
				const { operation } = yield* tasks.review(review())
				control.prepareError = WorkerError.make({ code: 'unavailable', message: 'Busy' })
				yield* scheduler.tick()
				expect((yield* store.getOperation(operation)).command.delivery).toMatchObject({
					_tag: 'Pending',
					step: 'session',
				})
				control.prepareError = WorkerError.make({ code: 'protocol', message: 'Invalid source' })
				yield* scheduler.tick()
				expect((yield* store.getOperation(operation)).command.delivery).toMatchObject({
					_tag: 'Rejected',
					reason: { code: 'preparation_failed', message: 'Invalid source' },
				})
			}),
		)
	} finally {
		await runtime.dispose()
	}
})

test('operation events settle on the native final result, not an idle session; cancelling a wait has no effect on the task', async () => {
	const { runtime, calls, control } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const scheduler = yield* Scheduler
				const { operation } = yield* tasks.review(review())

				const views = yield* tasks.events(operation)
				const subscribed = yield* Deferred.make<void>()
				const abandoned = yield* views.pipe(
					Stream.tap(() => Deferred.succeed(subscribed, undefined)),
					Stream.runDrain,
					Effect.forkChild,
				)
				yield* Deferred.await(subscribed)
				yield* Fiber.interrupt(abandoned)

				const seen = yield* Queue.unbounded<OperationView>()
				const collected = yield* (yield* tasks.events(operation)).pipe(
					Stream.tap((view) => Queue.offer(seen, view)),
					Stream.runCollect,
					Effect.forkChild,
				)
				const awaitState = Effect.fn('Test.awaitState')(function* (
					tag: OperationView['state']['_tag'],
				) {
					while ((yield* Queue.take(seen)).state._tag !== tag);
				})
				yield* awaitState('Queued')

				yield* scheduler.tick()
				yield* awaitState('Running')
				control.observation = { _tag: 'Idle' }
				yield* scheduler.tick()
				yield* awaitState('Pending')
				control.result = { _tag: 'Completed', message: { id: 'msg_final', text: 'Done' } }
				yield* scheduler.tick()

				const states = (yield* Fiber.join(collected)).map((view) => view.state)
				expect(states[0]?._tag).toBe('Queued')
				expect(states.slice(-3)).toEqual([
					{ _tag: 'Running' },
					{ _tag: 'Pending' },
					{ _tag: 'Completed', message: { id: 'msg_final', text: 'Done' } },
				])
			}),
		)
		expect(calls.some((call) => call.operation === 'interrupt')).toBe(false)
	} finally {
		await runtime.dispose()
	}
})

test('a lost preparation reply repeats only the idempotent preparation before one prompt', async () => {
	const { runtime, calls, control } = coordinator()
	control.losePrepareReply = true
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const store = yield* TaskStore
				const scheduler = yield* Scheduler
				const { operation } = yield* tasks.review(review())
				yield* scheduler.tick()
				expect((yield* store.getOperation(operation)).command.delivery).toMatchObject({
					_tag: 'Pending',
					step: 'session',
				})
				control.losePrepareReply = false
				yield* scheduler.tick()
				expect((yield* store.getOperation(operation)).command.delivery._tag).toBe('Acknowledged')
			}),
		)
		const prepares = calls.filter((call) => call.operation === 'prepareSession')
		expect(prepares).toHaveLength(2)
		expect(prepares[1]?.session).toEqual(prepares[0]?.session)
		expect(calls.filter((call) => call.operation === 'admit')).toHaveLength(1)
	} finally {
		await runtime.dispose()
	}
})

test('a long Capsule preparation neither starves another task’s interrupt nor survives scheduler shutdown', async () => {
	const { runtime, calls, control } = coordinator({ workers: [{ ...worker, capacity: 2 }] })
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const store = yield* TaskStore
				const scheduler = yield* Scheduler
				const running = yield* tasks.review(review(1))
				yield* scheduler.tick()
				yield* TestClock.adjust(1)

				control.prepareGate = yield* Deferred.make<void>()
				const provisioning = yield* tasks.review(review(2))
				control.prepareStarted = yield* Deferred.make<void>()
				const loop = yield* scheduler.run.pipe(Effect.forkChild)
				yield* Deferred.await(control.prepareStarted)

				expect((yield* tasks.interrupt(running.operation)).status).toBe('Requested')
				const delivered = yield* awaitAcknowledged(store.findAction('interrupt', running.operation))
				expect(delivered._tag).toBe('Some')
				const waiting = yield* store.getOperation(provisioning.operation)
				expect(waiting.command.delivery).toMatchObject({ _tag: 'Pending', step: 'session' })

				yield* Fiber.interrupt(loop)
				expect(control.preparesInterrupted).toBe(1)
			}).pipe(Effect.scoped),
		)
		expect(calls.filter((call) => call.operation === 'interrupt')).toHaveLength(1)
	} finally {
		await runtime.dispose()
	}
})

test.each<Pick<SessionPlacement, 'capsulePhase' | 'workspaceState'>>([
	{ capsulePhase: 'stopped', workspaceState: 'bound' },
	{ capsulePhase: 'purged', workspaceState: 'absent' },
	{ capsulePhase: 'ready', workspaceState: 'absent' },
])('an interrupt reaches a $capsulePhase Capsule with a $workspaceState workspace after identity proof alone', async (placement) => {
	const { runtime, calls, control } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const store = yield* TaskStore
				const scheduler = yield* Scheduler
				const { operation } = yield* tasks.review(review())
				yield* scheduler.tick()
				control.placement = placement
				yield* tasks.interrupt(operation)
				yield* scheduler.tick()
				const stop = yield* store.findAction('interrupt', operation)
				expect(stop?.command.delivery._tag).toBe('Acknowledged')
				expect((yield* tasks.interrupt(operation)).status).toBe('Acknowledged')
			}),
		)
		expect(calls.filter((call) => call.operation === 'interrupt')).toHaveLength(1)
		expect(calls.filter((call) => call.operation === 'prepareSession')).toHaveLength(1)
	} finally {
		await runtime.dispose()
	}
})

test('a continuation waits unsent for a ready, bound Capsule without preparing or reviving it', async () => {
	const { runtime, calls, control } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const store = yield* TaskStore
				const scheduler = yield* Scheduler
				const { operation } = yield* tasks.review(review())
				yield* scheduler.tick()
				settleNative(control)

				const expired = yield* tasks.continue(operation)
				control.placement = { capsulePhase: 'stopped', workspaceState: 'bound' }
				yield* scheduler.tick()
				yield* scheduler.tick()
				expect((yield* store.getOperation(expired.operation)).command.delivery).toMatchObject({
					_tag: 'Pending',
					step: 'send',
				})
				yield* TestClock.adjust(settings.queueTimeoutMs)
				yield* scheduler.tick()
				expect((yield* store.getOperation(expired.operation)).command.delivery).toMatchObject({
					_tag: 'Rejected',
					reason: { code: 'queue_timeout' },
				})

				control.placement = { capsulePhase: 'ready', workspaceState: 'bound' }
				const held = yield* tasks.continue(expired.operation)
				control.placement = { capsulePhase: 'ready', workspaceState: 'unprovisioned' }
				yield* scheduler.tick()
				expect((yield* store.getOperation(held.operation)).command.delivery._tag).toBe('Pending')
				control.placement = { capsulePhase: 'ready', workspaceState: 'bound' }
				yield* scheduler.tick()
				expect((yield* store.getOperation(held.operation)).command.delivery._tag).toBe(
					'Acknowledged',
				)
			}),
		)
		expect(calls.filter((call) => call.operation === 'admit')).toHaveLength(2)
		expect(calls.filter((call) => call.operation === 'prepareSession')).toHaveLength(1)
	} finally {
		await runtime.dispose()
	}
})

test('an unconfirmed message is still reconciled exactly after its Capsule stops or is purged', async () => {
	const { runtime, calls, control } = coordinator()
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const tasks = yield* Tasks
				const store = yield* TaskStore
				const scheduler = yield* Scheduler
				const { operation } = yield* tasks.review(review())
				yield* scheduler.tick()
				settleNative(control)
				control.loseAdmitReply = true
				control.historyUnavailable = true
				const continued = yield* tasks.continue(operation)
				yield* scheduler.tick()
				expect((yield* store.getOperation(continued.operation)).command.delivery._tag).toBe(
					'Unconfirmed',
				)

				control.placement = { capsulePhase: 'purged', workspaceState: 'absent' }
				control.historyUnavailable = false
				yield* scheduler.tick()
				const { task, command } = yield* store.getOperation(continued.operation)
				expect(command.delivery).toEqual({
					_tag: 'Acknowledged',
					nativeRef: {
						sessionId: `ses_pipeline${task.id.replaceAll('-', '')}`,
						messageId: command.messageId,
					},
				})
			}),
		)
		expect(calls.filter((call) => call.operation === 'admit')).toHaveLength(2)
	} finally {
		await runtime.dispose()
	}
})
