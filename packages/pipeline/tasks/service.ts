import { randomUUID } from 'node:crypto'
import { Clock, Context, Effect, Layer, Stream } from 'effect'
import { PipelineConfig } from '../config'
import { PullRequestUnavailable } from '../github/schema'
import { GitHub } from '../github/service'
import type { NativeObservation } from '../worker/schema'
import { OpenCodeWorker } from '../worker/service'
import { pullRequestSource } from '../worker/source'
import { type Payload, StoredCommand } from './command'
import { interruptIntent, resumeIntent, reviewIntent } from './intent'
import { deliveryTerminal, receipt } from './machine'
import { pinnedWorker, sessionIdentity } from './placement'
import { resumePrompt, reviewPrompt } from './prompt'
import {
	type CommandView,
	type InterruptRequest,
	type ResumeRequest,
	type ReviewRequest,
	Task,
} from './schema'
import { TaskStore } from './store'

function dispatchReceipt(stored: { task: Task; command: StoredCommand }) {
	return { task: stored.task, command: receipt(stored.command) }
}

function commandKind(payload: Payload): StoredCommand['kind'] {
	switch (payload._tag) {
		case 'Review':
			return 'review'
		case 'Resume':
			return 'resume'
		case 'Interrupt':
			return 'interrupt'
	}
}

function nativeTarget(command: StoredCommand): string | undefined {
	switch (command.delivery._tag) {
		case 'Unconfirmed':
		case 'Acknowledged':
			return command.messageId
		default:
			return undefined
	}
}

function latestAcknowledgedMessage(commands: ReadonlyArray<StoredCommand>): string | undefined {
	return commands
		.filter(
			(command) => command.delivery._tag === 'Acknowledged' && command.messageId !== undefined,
		)
		.at(-1)?.messageId
}

export function commandViewSettled(view: CommandView): boolean {
	if (!deliveryTerminal(view.command)) return false
	if (view.command.delivery._tag !== 'Acknowledged') return true
	switch (view.observation._tag) {
		case 'Idle':
		case 'NeedsInput':
		case 'InputCancelled':
			return true
		default:
			return false
	}
}

const make = Effect.gen(function* () {
	const store = yield* TaskStore
	const github = yield* GitHub
	const config = yield* PipelineConfig
	const remote = yield* OpenCodeWorker

	const newCommand = Effect.fn('Tasks.newCommand')(function* (
		taskId: string,
		requestHash: string,
		payload: Payload,
		afterCommandId?: string,
	) {
		const id = yield* Effect.sync(randomUUID)
		const createdAt = yield* Clock.currentTimeMillis
		const kind = commandKind(payload)
		return StoredCommand.make({
			id,
			taskId,
			createdAt,
			version: 0,
			kind,
			requestHash,
			...(afterCommandId === undefined ? {} : { afterCommandId }),
			...(kind === 'interrupt' ? {} : { messageId: `msg_pipeline${id.replaceAll('-', '')}` }),
			delivery: { _tag: 'Pending', step: kind === 'review' ? 'session' : 'send', payload },
		})
	})

	const submit = Effect.fn('Tasks.submit')(function* (key: string, request: ReviewRequest) {
		const requestHash = reviewIntent(request)
		const existing = yield* store.findKey(key, requestHash)
		if (existing !== undefined) return dispatchReceipt(existing)

		const pr = yield* github.resolve(request)
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
			request,
			submissions: { _tag: 'Open' },
			placement: { _tag: 'Unassigned' },
		})
		const command = yield* newCommand(task.id, requestHash, {
			_tag: 'Review',
			pr,
			source,
			prompt: reviewPrompt(task.id, pr),
		})
		const stored = yield* store.insert(task, command, key)
		return dispatchReceipt(stored)
	})

	const resume = Effect.fn('Tasks.resume')(function* (
		taskId: string,
		key: string,
		request: ResumeRequest,
	) {
		const requestHash = resumeIntent(taskId, request)
		const existing = yield* store.findKey(key, requestHash)
		if (existing !== undefined) return dispatchReceipt(existing)

		const task = yield* store.getTask(taskId)
		const prompt = resumePrompt(task.request.pr, request.message)
		const command = yield* newCommand(
			taskId,
			requestHash,
			{ _tag: 'Resume', prompt },
			request.afterCommandId,
		)
		const stored = yield* store.append(taskId, command, key)
		return dispatchReceipt(stored)
	})

	const interrupt = Effect.fn('Tasks.interrupt')(function* (
		taskId: string,
		key: string,
		request: InterruptRequest,
	) {
		const requestHash = interruptIntent(taskId, request)
		const existing = yield* store.findKey(key, requestHash)
		if (existing !== undefined) return dispatchReceipt(existing)

		const command = yield* newCommand(
			taskId,
			requestHash,
			{ _tag: 'Interrupt' },
			request.afterCommandId,
		)
		const stored = yield* store.append(taskId, command, key)
		return dispatchReceipt(stored)
	})

	const observe = Effect.fn('Tasks.observe')(function* (task: Task, messageId: string | undefined) {
		if (task.placement._tag === 'Unassigned')
			return { _tag: 'NotObserved' } satisfies NativeObservation
		const { assignment } = task.placement
		const worker = pinnedWorker(config.workers, assignment)
		if (worker === undefined)
			return {
				_tag: 'Unavailable',
				message: 'Restore the pinned worker configuration to observe the native session',
			} satisfies NativeObservation
		return yield* remote.observe(worker, sessionIdentity(task, assignment), messageId).pipe(
			Effect.catchTag('WorkerError', () =>
				Effect.succeed({
					_tag: 'Unavailable',
					message: 'Native session observation is unavailable',
				} satisfies NativeObservation),
			),
		)
	})

	const getCommand = Effect.fn('Tasks.getCommand')(function* (taskId: string, commandId: string) {
		const { task, command } = yield* store.getCommand(taskId, commandId)
		return {
			task,
			command: receipt(command),
			observation: yield* observe(task, nativeTarget(command)),
		} satisfies CommandView
	})

	const get = Effect.fn('Tasks.get')(function* (taskId: string) {
		const { task, commands } = yield* store.get(taskId)
		return {
			task,
			commands: commands.map(receipt),
			observation: yield* observe(task, latestAcknowledgedMessage(commands)),
		}
	})

	const events = Effect.fn('Tasks.events')(function* (taskId: string, commandId: string) {
		yield* store.getCommand(taskId, commandId)
		return Stream.unwrap(
			Effect.gen(function* () {
				const updates = yield* store.subscribeUpdates
				const read = getCommand(taskId, commandId).pipe(Effect.orDie)
				const initial = yield* read
				const changes = Stream.fromSubscription(updates).pipe(
					Stream.filter((id) => id === taskId),
					Stream.mapEffect(() => read),
				)
				return Stream.make(initial).pipe(
					Stream.concat(changes),
					Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
					Stream.takeUntil(commandViewSettled),
				)
			}),
		)
	})

	return { submit, resume, interrupt, close: store.close, get, getCommand, events }
})

export class Tasks extends Context.Service<Tasks, Effect.Success<typeof make>>()(
	'pipeline/tasks/Tasks',
) {}
export const tasksLayer = Layer.effect(Tasks, make)
