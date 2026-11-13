import type { SessionPlacement } from '@limitless/capsule/rpc'
import {
	Clock,
	Context,
	Effect,
	FiberSet,
	Layer,
	Option,
	Queue,
	Schema,
	Semaphore,
	Stream,
} from 'effect'
import { PipelineConfig } from './config'
import type { CommandEvent, StoredCommand } from './tasks/command'
import { deliveryTerminal } from './tasks/machine'
import { newAssignment, pinnedWorker, sessionIdentity } from './tasks/placement'
import type { Assignment, Rejection, Task } from './tasks/schema'
import { TaskStore } from './tasks/store'
import { type Worker, WorkerError } from './worker/schema'
import { OpenCodeWorker } from './worker/service'

class DispatchDefect extends Schema.TaggedError<DispatchDefect>()('DispatchDefect', {
	reason: Schema.Literals(['payload_mismatch', 'missing_message_id']),
}) {}

type Placed = { task: Task; worker: Worker; assignment: Assignment }
type CommandIn<Tag extends StoredCommand['delivery']['_tag']> = Omit<StoredCommand, 'delivery'> & {
	delivery: Extract<StoredCommand['delivery'], { _tag: Tag }>
}
type PendingCommand = CommandIn<'Pending'>
type UnconfirmedCommand = CommandIn<'Unconfirmed'>
type Pass = { again: boolean }

/** Messages need a running Capsule; interrupts only need the proven identity, so they reach a stopped one. */
function acceptsMessages(placement: SessionPlacement): boolean {
	return placement.capsulePhase === 'ready' && placement.workspaceState === 'bound'
}

function rejection(error: WorkerError, step: PendingCommand['delivery']['step']): Rejection {
	if (error.code === 'incompatible') return { code: 'worker_incompatible', message: error.message }
	if (step === 'session') return { code: 'preparation_failed', message: error.message }
	return { code: 'session_unavailable', message: error.message }
}

const make = Effect.gen(function* () {
	const config = yield* PipelineConfig
	const store = yield* TaskStore
	const remote = yield* OpenCodeWorker
	const placementLock = yield* Semaphore.make(1)
	const reconciling = new Map<string, Pass>()

	const apply = (command: StoredCommand, event: CommandEvent) =>
		store.apply(command.taskId, command.id, command.version, event)
	const reject = (command: StoredCommand, reason: Rejection) =>
		apply(command, { _tag: 'Rejected', reason })

	const requirePinnedWorker = Effect.fn('Scheduler.requirePinnedWorker')(function* (
		assignment: Assignment,
	) {
		const worker = pinnedWorker(config.workers, assignment)
		if (worker === undefined)
			return yield* WorkerError.make({
				code: 'unavailable',
				message: 'Restore the pinned worker configuration before dispatch',
			})
		return worker
	})

	const claimNewPlacement = Effect.fn('Scheduler.claimNewPlacement')(function* (
		task: Task,
		command: PendingCommand,
	) {
		for (const worker of config.workers) {
			if (!(yield* store.hasCapacity(worker))) continue
			const host = yield* remote.ready(worker).pipe(Effect.option)
			if (Option.isNone(host)) continue
			const assignment = newAssignment(worker, host.value, task.id)
			const claimed = yield* store
				.claim(task.id, command.id, command.version, worker, assignment)
				.pipe(Effect.option)
			if (Option.isSome(claimed)) return { task: claimed.value.task, worker, assignment }
		}
		return undefined
	}, placementLock.withPermit)

	const place = Effect.fn('Scheduler.place')(function* (task: Task, command: PendingCommand) {
		if (task.placement._tag === 'Unassigned') return yield* claimNewPlacement(task, command)
		const { assignment } = task.placement
		const worker = yield* requirePinnedWorker(assignment)
		const claimed = yield* store.claim(task.id, command.id, command.version, worker, assignment)
		return { task: claimed.task, worker, assignment } satisfies Placed
	})

	// IDs and source intent are durable before this idempotent call, so a lost reply only repeats it.
	const prepareSession = Effect.fn('Scheduler.prepareSession')(function* (
		placed: Placed,
		command: PendingCommand,
	) {
		const { payload } = command.delivery
		if (payload._tag !== 'Review')
			return yield* Effect.die(DispatchDefect.make({ reason: 'payload_mismatch' }))
		yield* remote.prepareSession(placed.worker, sessionIdentity(placed.task, placed.assignment), {
			source: payload.source,
			pr: payload.pr.url,
		})
		yield* apply(command, { _tag: 'SessionPrepared' })
	})

	const deliver = Effect.fn('Scheduler.deliver')(function* (
		placed: Placed,
		command: UnconfirmedCommand,
	) {
		const identity = sessionIdentity(placed.task, placed.assignment)
		const { payload } = command.delivery
		if (payload._tag === 'Interrupt') return yield* remote.interrupt(placed.worker, identity)
		if (command.messageId === undefined)
			return yield* Effect.die(DispatchDefect.make({ reason: 'missing_message_id' }))
		return yield* remote.admit(placed.worker, identity, command.messageId, payload.prompt)
	})

	// The Unconfirmed commit precedes the native write so a crash or lost reply can never replay it.
	const send = Effect.fn('Scheduler.send')(function* (placed: Placed, command: PendingCommand) {
		const placement = yield* remote.requirePlacement(
			placed.worker,
			sessionIdentity(placed.task, placed.assignment),
		)
		if (command.kind !== 'interrupt' && !acceptsMessages(placement))
			return yield* WorkerError.make({
				code: 'unavailable',
				message: 'The Capsule must be ready with a bound workspace before a message is sent',
			})
		const { command: started } = yield* apply(command, { _tag: 'DeliveryStarted' })
		if (started.delivery._tag !== 'Unconfirmed') return
		const nativeRef = yield* deliver(placed, { ...started, delivery: started.delivery })
		yield* apply(started, { _tag: 'Acknowledged', nativeRef })
	})

	const advance = Effect.fn('Scheduler.advance')(function* (task: Task, command: PendingCommand) {
		const now = yield* Clock.currentTimeMillis
		if (now - command.createdAt >= config.queueTimeoutMs) {
			yield* reject(command, {
				code: 'queue_timeout',
				message: 'The command was not sent within the queue timeout',
			})
			return
		}
		if (task.placement._tag === 'Unassigned' && command.kind !== 'review') {
			yield* reject(command, {
				code: 'session_unavailable',
				message: 'The task has no native session to receive this command',
			})
			return
		}

		const placed = yield* place(task, command)
		if (placed === undefined) return
		switch (command.delivery.step) {
			case 'session':
				return yield* prepareSession(placed, command)
			case 'send':
				return yield* send(placed, command)
		}
	})

	const rejectPending = Effect.fn('Scheduler.rejectPending')(function* (
		command: PendingCommand,
		error: WorkerError,
	) {
		if (error.code === 'unavailable') return
		const current = yield* store.getCommand(command.taskId, command.id)
		if (current.command.delivery._tag !== 'Pending') return
		yield* reject(current.command, rejection(error, current.command.delivery.step))
	})

	const dispatch = Effect.fn('Scheduler.dispatch')(function* (task: Task, command: PendingCommand) {
		yield* advance(task, command).pipe(
			Effect.catchTag('WorkerError', (error) => rejectPending(command, error)),
		)
	})

	const confirm = Effect.fn('Scheduler.confirm')(function* (
		task: Task,
		command: UnconfirmedCommand,
	) {
		const { payload } = command.delivery
		if (task.placement._tag !== 'Assigned' || payload._tag === 'Interrupt') return
		if (command.messageId === undefined)
			return yield* Effect.die(DispatchDefect.make({ reason: 'missing_message_id' }))
		const { assignment } = task.placement
		const worker = yield* requirePinnedWorker(assignment)
		const nativeRef = yield* remote.findAdmission(
			worker,
			sessionIdentity(task, assignment),
			command.messageId,
			payload.prompt,
		)
		if (nativeRef !== undefined) yield* apply(command, { _tag: 'Acknowledged', nativeRef })
	})

	const step = Effect.fn('Scheduler.step')(function* (task: Task, command: StoredCommand) {
		const { delivery } = command
		switch (delivery._tag) {
			case 'Pending':
				return yield* dispatch(task, { ...command, delivery })
			case 'Unconfirmed':
				return yield* confirm(task, { ...command, delivery })
		}
	})

	const releaseIfIdle = Effect.fn('Scheduler.releaseIfIdle')(function* (
		task: Task,
		commands: ReadonlyArray<StoredCommand>,
	) {
		if (!(yield* store.hasLease(task.id))) return
		const acknowledged = commands.filter((command) => command.delivery._tag === 'Acknowledged')
		if (acknowledged.length === 0 || task.placement._tag === 'Unassigned') {
			yield* store.release(task.id)
			return
		}

		const { assignment } = task.placement
		const worker = yield* requirePinnedWorker(assignment)
		const identity = sessionIdentity(task, assignment)
		const target = acknowledged
			.filter((command) => command.messageId !== undefined)
			.at(-1)?.messageId
		const observation = yield* remote.observe(worker, identity, target)
		if (observation._tag === 'InputCancelled') {
			const session = yield* remote.observe(worker, identity)
			if (session._tag === 'Idle') yield* store.release(task.id)
			return
		}
		if (observation._tag === 'Idle') yield* store.release(task.id)
	})

	const reconcile = Effect.fn('Scheduler.reconcile')(function* (
		taskId: string,
	): Effect.fn.Return<void, never> {
		const { task, commands } = yield* store.get(taskId).pipe(Effect.orDie)
		const command = commands.find((command) => !deliveryTerminal(command))
		if (command === undefined) {
			yield* releaseIfIdle(task, commands).pipe(Effect.catchTag('WorkerError', () => Effect.void))
			return
		}

		yield* step(task, command).pipe(
			Effect.catchTag('WorkerError', () => Effect.void),
			Effect.catchTag('TaskConflict', () => Effect.void),
			Effect.orDie,
		)
		const current = yield* store.getCommand(taskId, command.id).pipe(Effect.orDie)
		if (current.command.version !== command.version) return yield* reconcile(taskId)
	})

	const claimPass = (taskId: string) =>
		Effect.sync(() => {
			const running = reconciling.get(taskId)
			if (running !== undefined) {
				running.again = true
				return undefined
			}
			const pass: Pass = { again: true }
			reconciling.set(taskId, pass)
			return pass
		})

	const runPasses = Effect.fn('Scheduler.runPasses')(function* (
		taskId: string,
		pass: Pass | undefined,
	) {
		if (pass === undefined) return
		while (pass.again) {
			pass.again = false
			yield* reconcile(taskId)
		}
	})

	const releasePass = (taskId: string, pass: Pass | undefined) =>
		Effect.sync(() => {
			if (pass !== undefined) reconciling.delete(taskId)
		})

	/** One reconcile per task at a time; a request during a pass schedules one more pass after it. */
	const reconcileExclusive = (taskId: string) =>
		Effect.acquireUseRelease(
			claimPass(taskId),
			(pass) => runPasses(taskId, pass),
			(pass) => releasePass(taskId, pass),
		)

	const notifyWorkers = Effect.forEach(config.workers, (worker) => store.notifyWorker(worker.id), {
		discard: true,
	})

	/** Deterministic test seam: reconciles outstanding tasks in order and waits for each pass. */
	const tick = Effect.fn('Scheduler.tick')(function* () {
		const tasks = yield* store.work()
		yield* Effect.forEach(tasks, reconcileExclusive, { discard: true })
		yield* notifyWorkers
	})

	const watchWorker = Effect.fn('Scheduler.watchWorker')(function* (
		worker: Worker,
		wake: Queue.Queue<void>,
	) {
		const changed = Effect.gen(function* () {
			yield* store.notifyWorker(worker.id)
			yield* Queue.offer(wake, undefined)
		})
		yield* changed
		yield* remote.watch(worker).pipe(
			Stream.runForEach(() => changed),
			Effect.catchTag('WorkerError', () => Effect.void),
		)
		yield* Effect.sleep(config.pollIntervalMs)
	})

	/** Each task's passes run in their own scoped fiber, so a long preparation never delays other tasks. */
	const run = Effect.gen(function* () {
		const wake = yield* Queue.sliding<void>(1)
		const changes = yield* store.subscribeChanges
		yield* Stream.fromSubscription(changes).pipe(
			Stream.runForEach(() => Queue.offer(wake, undefined)),
			Effect.forkScoped,
		)
		yield* Effect.forEach(
			config.workers,
			(worker) => watchWorker(worker, wake).pipe(Effect.forever, Effect.forkScoped),
			{ discard: true },
		)
		const passes = yield* FiberSet.make<void, never>()
		const schedule = Effect.gen(function* () {
			const tasks = yield* store.work()
			yield* Effect.forEach(tasks, (taskId) => FiberSet.run(passes, reconcileExclusive(taskId)), {
				discard: true,
			})
			yield* notifyWorkers
			yield* Effect.raceFirst(Queue.take(wake), Effect.sleep(config.pollIntervalMs))
		})
		return yield* Effect.raceFirst(schedule.pipe(Effect.forever), FiberSet.join(passes))
	}).pipe(Effect.scoped)

	return { tick, run }
})

export class Scheduler extends Context.Service<Scheduler, Effect.Success<typeof make>>()(
	'pipeline/scheduler/Scheduler',
) {}
export const schedulerLayer = Layer.effect(Scheduler, make)
