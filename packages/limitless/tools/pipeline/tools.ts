import type { Tool } from '@opencode/schema/tool'
import { Tool as ToolSchema } from '@opencode/schema/tool'
import { Effect, Schema } from 'effect'
import { Task, TaskId } from '../../../pipeline/tasks/schema'
import { defineLimitlessTool } from '../../plugin/tool-boundary'
import { type makePipelineClient, WaitInput, WaitResult } from './client'
import { Admission, InterruptInput, PipelineError, ResumeInput, ReviewInput } from './receipts'

export const pipelineMutationTools = [
	'pipeline_review',
	'pipeline_resume',
	'pipeline_interrupt',
	'pipeline_close',
] as const

export function pipelineTools(client: Effect.Success<ReturnType<typeof makePipelineClient>>) {
	const execute = <A>(
		context: Tool.Context,
		operation: Effect.Effect<A, PipelineError>,
		mutation: boolean,
	) =>
		Effect.gen(function* () {
			if (mutation && context.agent !== 'limitless') {
				return yield* PipelineError.make({
					code: 'forbidden',
					message:
						'Only the primary limitless agent may mutate Pipeline tasks. Review and research agents must not submit recursive work.',
				})
			}
			const output = yield* operation
			return { output, content: [{ type: 'text' as const, text: JSON.stringify(output) }] }
		}).pipe(
			Effect.mapError((error) =>
				ToolSchema.Error.make({ message: error.message, metadata: { code: error.code } }),
			),
			Effect.catchDefect(() =>
				Effect.fail(
					ToolSchema.Error.make({
						message:
							'Pipeline tool failed unexpectedly. Recover the existing durable receipt; do not submit replacement work.',
					}),
				),
			),
		)
	return {
		pipeline_review: defineLimitlessTool({
			name: 'pipeline_review',
			description:
				'Dispatch a PR review into a retained checkout and native OpenCode session, or recover this session’s current receipt for that PR, including previously accepted ones. Inputs are immutable; a changed request conflicts. Only passing the previous accepted task as afterTaskId creates a fresh task and advances the sticky receipt; repeating that predecessor recovers the same task. AdmissionUnknown requires repeating the exact original request; unconfirmed native delivery is never replayed. Native OpenCode owns execution, history, and outputs.',
			input: ReviewInput,
			output: Admission,
			execute: (input, context) => execute(context, client.review(context.sessionID, input), true),
		}),
		pipeline_resume: defineLimitlessTool({
			name: 'pipeline_resume',
			description:
				'Explicitly send an immutable followup message to the task’s existing native OpenCode session. afterCommandId is a caller intent anchor belonging to this task, not a result or execution status. Repeating taskId/afterCommandId recovers the same command; a changed message conflicts. Unconfirmed native delivery blocks followups. Recover AdmissionUnknown with the exact original request.',
			input: ResumeInput,
			output: Admission,
			execute: (input, context) => execute(context, client.resume(context.sessionID, input), true),
		}),
		pipeline_wait: defineLimitlessTool({
			name: 'pipeline_wait',
			description:
				'Observe one dispatch command and its native OpenCode session through the event stream, without model polling. Observed means the command was rejected or cancelled before send, or was positively acknowledged and the native session is now Idle, NeedsInput, or InputCancelled; it is not a verdict, a result, or proof that all OS writers stopped. Unconfirmed delivery stays Pending: it never means the command did not start or has stopped, and it blocks automatic followups. Omit timeoutMs for an unbounded wait; a positive budget may return Pending; 0 reads once. Unavailable means the view could not be read. Detaching never interrupts or resubmits execution. Session and directory references are in view.task.placement; messages, history, and outputs belong to native OpenCode.',
			input: WaitInput,
			output: WaitResult,
			execute: (input, context) => execute(context, client.wait(input, context.progress), false),
		}),
		pipeline_interrupt: defineLimitlessTool({
			name: 'pipeline_interrupt',
			description:
				'Explicitly forward a native interrupt with a durable idempotent dispatch receipt. afterCommandId is a caller intent anchor belonging to this task, not a native execution run. The returned receipt and any native acknowledgement are not proof execution stopped, and native Idle is not proof all OS writers exited. Repeating the same taskId/afterCommandId recovers the same command. Never interrupt merely to detach a waiter.',
			input: InterruptInput,
			output: Admission,
			execute: (input, context) =>
				execute(context, client.interrupt(context.sessionID, input), true),
		}),
		pipeline_close: defineLimitlessTool({
			name: 'pipeline_close',
			description:
				'Explicitly close a task logically: disable future messages and cancel unsent ones. The checkout and native session are retained. This does not interrupt in-flight execution, prove it stopped, archive anything, or delete the checkout.',
			input: Schema.Struct({ taskId: TaskId }),
			output: Task,
			execute: (input, context) => execute(context, client.close(input.taskId), true),
		}),
	}
}
