import { randomUUID } from 'node:crypto'
import { Clock, Context, Effect, Layer, Stream } from 'effect'
import { PipelineConfig } from '../config'
import { PullRequestUnavailable } from '../github/schema'
import { GitHub } from '../github/service'
import type { NativeResult } from '../worker/schema'
import { OpenCodeWorker } from '../worker/service'
import { pullRequestSource } from '../worker/source'
import {
	type InterruptReceipt,
	nativeEvaluationBudgetMs,
	type OperationReceipt,
	type OperationState,
	type OperationView,
	operationSettled,
	type ReviewInput,
} from '../workflow'
import { type Payload, StoredCommand } from './command'
import { pinnedWorker, sessionIdentity } from './placement'
import { continuePrompt, reviewPrompt } from './prompt'
import { OperationNotFound, Task, TaskConflict } from './schema'
import { TaskStore } from './store'

type StoredOperation = { task: Task; command: StoredCommand }

function operationReceipt({ task, command }: StoredOperation): OperationReceipt {
	return { operation: command.id, pr: task.request.pr, closed: task.submissions._tag === 'Closed' }
}

function interruptReceipt(target: StoredOperation, command: StoredCommand): InterruptReceipt {
	const status = () => {
		switch (command.delivery._tag) {
			case 'Pending':
				return 'Requested'
			case 'Unconfirmed':
				return 'DeliveryUnconfirmed'
			case 'Acknowledged':
				return 'Acknowledged'
			default:
				return 'Rejected'
		}
	}
	return { ...operationReceipt(target), status: status() }
}

function executionSettled(result: NativeResult): boolean {
	return result._tag !== 'Pending' && result._tag !== 'Unavailable'
}

const evaluationDeadline = Effect.timeoutOrElse({
	duration: nativeEvaluationBudgetMs,
	orElse: () => TaskConflict.make({ code: 'observation_timeout' }),
})

const make = Effect.gen(function* () {
	const store = yield* TaskStore
	const github = yield* GitHub
	const config = yield* PipelineConfig
	const remote = yield* OpenCodeWorker

	const newCommand = Effect.fn('Tasks.newCommand')(function* (
		taskId: string,
		payload: Payload,
		afterCommandId?: string,
	) {
		const id = yield* Effect.sync(randomUUID)
		const kind =
			payload._tag === 'Review' ? 'review' : payload._tag === 'Resume' ? 'resume' : 'interrupt'
		return StoredCommand.make({
			id,
			taskId,
			createdAt: yield* Clock.currentTimeMillis,
			version: 0,
			kind,
			...(afterCommandId === undefined ? {} : { afterCommandId }),
			...(kind === 'interrupt' ? {} : { messageId: `msg_pipeline${id.replaceAll('-', '')}` }),
			delivery: { _tag: 'Pending', step: kind === 'review' ? 'session' : 'send', payload },
		})
	})

	const prepareReview = Effect.fn('Tasks.prepareReview')(function* (
		resolved: Effect.Success<ReturnType<typeof github.resolve>>,
	) {
		const pr = resolved.checkout
		if (pr === undefined)
			return yield* PullRequestUnavailable.make({
				message: 'A fresh review requires an open pull request with an available source repository',
			})
		const source = yield* pullRequestSource(pr).pipe(
			Effect.mapError(() =>
				PullRequestUnavailable.make({
					message: 'Pull request head is not a supported checkout source',
				}),
			),
		)
		const task = Task.make({
			id: yield* Effect.sync(randomUUID),
			createdAt: yield* Clock.currentTimeMillis,
			reviewKey: resolved.key,
			request: { pr: resolved.url },
			submissions: { _tag: 'Open' },
			placement: { _tag: 'Unassigned' },
		})
		const command = yield* newCommand(task.id, {
			_tag: 'Review',
			pr,
			source,
			prompt: reviewPrompt(task.id, pr),
		})
		return { task, command }
	})

	const review = Effect.fn('Tasks.review')(function* (input: ReviewInput) {
		const resolved = yield* github.resolve(input)
		const existing = yield* store.current(resolved.key)
		if (existing !== undefined) return operationReceipt(existing)
		const { task, command } = yield* prepareReview(resolved)
		const stored = yield* store.insert(task, command)
		return operationReceipt(stored)
	})

	const placement = Effect.fn('Tasks.placement')(function* (task: Task) {
		if (task.placement._tag !== 'Assigned')
			return yield* TaskConflict.make({ code: 'session_unavailable' })
		const { assignment } = task.placement
		const worker = pinnedWorker(config.workers, assignment)
		if (worker === undefined) return yield* TaskConflict.make({ code: 'session_unavailable' })
		return { worker, identity: sessionIdentity(task, assignment) }
	})

	const requireSettled = Effect.fn('Tasks.requireSettled')(
		function* ({ task, command }: StoredOperation, action: 'continue' | 'restart') {
			if (command.delivery._tag === 'Unconfirmed')
				return yield* TaskConflict.make({ code: 'delivery_unconfirmed' })
			if (command.delivery._tag === 'Pending')
				return yield* TaskConflict.make({ code: 'operation_pending' })
			if (action === 'restart' && command.delivery._tag !== 'Acknowledged') {
				const { commands } = yield* store.get(task.id)
				if (
					!commands.some(
						(item) => item.kind !== 'interrupt' && item.delivery._tag === 'Acknowledged',
					)
				)
					return
			}
			const { worker, identity } = yield* placement(task)
			const placed = yield* remote.requirePlacement(worker, identity)
			if (
				action === 'continue' &&
				(placed.capsulePhase !== 'ready' || placed.workspaceState !== 'bound')
			)
				return yield* TaskConflict.make({ code: 'session_unavailable' })
			if (command.delivery._tag === 'Acknowledged') {
				if (command.messageId === undefined)
					return yield* TaskConflict.make({ code: 'session_unavailable' })
				const result = yield* remote.result(worker, identity, command.messageId)
				if (!executionSettled(result)) return yield* TaskConflict.make({ code: 'native_unsettled' })
			}
			const observation = yield* remote.observe(worker, identity)
			if (observation._tag !== 'Idle') return yield* TaskConflict.make({ code: 'native_unsettled' })
		},
		Effect.catchTag('WorkerError', () => TaskConflict.make({ code: 'session_unavailable' })),
	)

	const recoverAccepted = Effect.fn('Tasks.recoverAccepted')(function* <E>(
		action: 'resume' | 'restart',
		after: string,
		error: E,
	) {
		const accepted = yield* store.findAction(action, after)
		if (accepted !== undefined) return operationReceipt(accepted)
		return yield* Effect.fail(error)
	})

	const readyForContinuation = Effect.fn('Tasks.readyForContinuation')(function* (after: string) {
		const anchor = yield* store.checkAnchor(after)
		yield* requireSettled(anchor, 'continue')
		return anchor
	}, evaluationDeadline)

	const prepareRestart = Effect.fn('Tasks.prepareRestart')(function* (after: string) {
		const anchor = yield* store.checkAnchor(after, { allowClosed: true })
		yield* requireSettled(anchor, 'restart')
		const resolved = yield* github.resolve(anchor.task.request)
		if (resolved.key !== anchor.task.reviewKey)
			return yield* PullRequestUnavailable.make({
				message:
					'The PR URL now identifies a different repository; restore its canonical URL before restarting',
			})
		return yield* prepareReview(resolved)
	}, evaluationDeadline)

	const continueReview = Effect.fn('Tasks.continue')(
		function* (after: string) {
			const existing = yield* store.findAction('resume', after)
			if (existing !== undefined) return operationReceipt(existing)
			const anchor = yield* readyForContinuation(after)
			const command = yield* newCommand(
				anchor.task.id,
				{
					_tag: 'Resume',
					prompt: continuePrompt(anchor.task.request.pr),
				},
				after,
			)
			const stored = yield* store.append(command)
			return operationReceipt(stored)
		},
		(effect, after) =>
			effect.pipe(Effect.catch((error) => recoverAccepted('resume', after, error))),
	)

	const restart = Effect.fn('Tasks.restart')(
		function* (after: string) {
			const existing = yield* store.findAction('restart', after)
			if (existing !== undefined) return operationReceipt(existing)
			const { task, command } = yield* prepareRestart(after)
			const stored = yield* store.restart(after, task, command)
			return operationReceipt(stored)
		},
		(effect, after) =>
			effect.pipe(Effect.catch((error) => recoverAccepted('restart', after, error))),
	)

	const interrupt = Effect.fn('Tasks.interrupt')(
		function* (after: string) {
			const existing = yield* store.findAction('interrupt', after)
			if (existing !== undefined) {
				const target = yield* store.getOperation(after)
				return interruptReceipt(target, existing.command)
			}
			const anchor = yield* store.checkAnchor(after, { allowClosed: true })
			if (anchor.command.delivery._tag === 'Unconfirmed')
				return yield* TaskConflict.make({ code: 'delivery_unconfirmed' })
			if (anchor.command.delivery._tag !== 'Acknowledged')
				return { ...operationReceipt(anchor), status: 'NotStarted' } satisfies InterruptReceipt
			const command = yield* newCommand(anchor.task.id, { _tag: 'Interrupt' }, after)
			const stored = yield* store.append(command)
			return interruptReceipt(anchor, stored.command)
		},
		(effect, after) =>
			effect.pipe(
				Effect.catch((error) =>
					Effect.gen(function* () {
						const accepted = yield* store.findAction('interrupt', after)
						if (accepted === undefined) return yield* error
						const target = yield* store.getOperation(after)
						return interruptReceipt(target, accepted.command)
					}),
				),
			),
	)

	const nativeState = Effect.fn('Tasks.nativeState')(
		function* ({ task, command }: StoredOperation) {
			const { worker, identity } = yield* placement(task)
			if (command.messageId === undefined)
				return {
					_tag: 'Unavailable',
					message: 'The native prompt reference is missing',
				} satisfies OperationState
			const result = yield* remote.result(worker, identity, command.messageId)
			if (result._tag !== 'Pending') return result
			const observation = yield* remote.observe(worker, identity, command.messageId)
			switch (observation._tag) {
				case 'NeedsInput':
					return {
						_tag: 'NeedsInput',
						permissions: observation.permissionIds.length,
						forms: observation.formIds.length,
					} satisfies OperationState
				case 'Running':
					return { _tag: 'Running' } satisfies OperationState
				case 'Unavailable':
					return observation
				default:
					return result
			}
		},
		Effect.catchTag('WorkerError', () =>
			Effect.succeed({
				_tag: 'Unavailable',
				message: 'Native result retrieval is unavailable; retry waiting on this operation',
			} satisfies OperationState),
		),
		Effect.timeoutOrElse({
			duration: nativeEvaluationBudgetMs,
			orElse: () =>
				Effect.succeed({
					_tag: 'Unavailable',
					message:
						'Native result evaluation exceeded its three-minute budget; retry waiting on this operation',
				} satisfies OperationState),
		}),
	)

	const state = Effect.fn('Tasks.state')(function* (stored: StoredOperation) {
		switch (stored.command.delivery._tag) {
			case 'Pending':
				return {
					_tag: stored.task.placement._tag === 'Unassigned' ? 'Queued' : 'Preparing',
				} satisfies OperationState
			case 'Unconfirmed':
				return { _tag: 'DeliveryUnconfirmed' } satisfies OperationState
			case 'Rejected':
				return {
					_tag: 'Rejected',
					message: stored.command.delivery.reason.message,
				} satisfies OperationState
			case 'CancelledBeforeSend':
				return { _tag: 'CancelledBeforeSend' } satisfies OperationState
			case 'Acknowledged':
				return yield* nativeState(stored).pipe(
					Effect.catchTag('TaskConflict', () =>
						Effect.succeed({
							_tag: 'Unavailable',
							message: 'Restore the retained worker and native session to read this result',
						} satisfies OperationState),
					),
				)
		}
	})

	const get = Effect.fn('Tasks.get')(function* (operation: string) {
		const stored = yield* store.getOperation(operation)
		if (stored.command.kind === 'interrupt') return yield* OperationNotFound.make({ operation })
		const { task } = stored
		return {
			...operationReceipt(stored),
			...(task.placement._tag === 'Assigned'
				? {
						session: {
							server: task.placement.assignment.workerUrl,
							id: task.placement.assignment.sessionId,
						},
					}
				: {}),
			state: yield* state(stored),
		} satisfies OperationView
	})

	const events = Effect.fn('Tasks.events')(function* (operation: string) {
		const { task, command } = yield* store.getOperation(operation)
		if (command.kind === 'interrupt') return yield* OperationNotFound.make({ operation })
		return Stream.unwrap(
			Effect.gen(function* () {
				const updates = yield* store.subscribeUpdates
				const read = get(operation).pipe(Effect.orDie)
				const initial = yield* read
				const changes = Stream.fromSubscription(updates).pipe(
					Stream.filter((id) => id === task.id),
					Stream.buffer({ capacity: 1, strategy: 'sliding' }),
					Stream.mapEffect(() => read),
				)
				return Stream.make(initial).pipe(
					Stream.concat(changes),
					Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
					Stream.takeUntil(operationSettled),
				)
			}),
		)
	})

	return { review, continue: continueReview, restart, interrupt, get, events }
})

export class Tasks extends Context.Service<Tasks, Effect.Success<typeof make>>()(
	'pipeline/tasks/Tasks',
) {}
export const tasksLayer = Layer.effect(Tasks, make)
