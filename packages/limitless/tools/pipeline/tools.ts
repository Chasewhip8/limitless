import type { Tool } from '@opencode/schema/tool'
import { Tool as ToolSchema } from '@opencode/schema/tool'
import { Effect } from 'effect'
import {
	ContinueInput,
	InterruptReceipt,
	OperationInput,
	OperationReceipt,
	ReviewInput,
} from '../../../pipeline/workflow'
import { defineLimitlessTool } from '../../plugin/tool-boundary'
import { type makePipelineClient, PipelineError, WaitResult } from './client'

export const pipelineMutationTools = [
	'pipeline_review',
	'pipeline_continue',
	'pipeline_restart',
	'pipeline_interrupt',
] as const

const lostResponse =
	'If the response is lost or the call is interrupted, repeat this exact call with identical arguments. Do not substitute a continuation or restart for recovery.'

const waitText = (result: WaitResult) => {
	if ('state' in result && result.state._tag === 'Completed') return result.state.message.text
	return JSON.stringify(result)
}

export function pipelineTools(client: Effect.Success<ReturnType<typeof makePipelineClient>>) {
	const execute = <A>(
		context: Tool.Context,
		operation: Effect.Effect<A, PipelineError>,
		options: { readonly mutation: boolean; readonly text?: (output: A) => string },
	) =>
		Effect.gen(function* () {
			if (options.mutation && context.agent !== 'limitless') {
				return yield* PipelineError.make({
					code: 'forbidden',
					message:
						'Only the primary limitless agent may mutate Pipeline reviews. Review and research agents must not submit recursive work.',
				})
			}
			const output = yield* operation
			const text = options.text?.(output) ?? JSON.stringify(output)
			return { output, content: [{ type: 'text' as const, text }] }
		}).pipe(
			Effect.mapError((error) =>
				ToolSchema.Error.make({
					message: error.message,
					metadata: {
						code: error.code,
						...(error.conflict === undefined ? {} : { conflict: error.conflict }),
					},
				}),
			),
			Effect.catchDefect(() =>
				Effect.fail(
					ToolSchema.Error.make({
						message:
							'Pipeline tool failed unexpectedly. Its request may have been accepted; repeat this exact call rather than submitting other work.',
					}),
				),
			),
		)
	return {
		pipeline_review: defineLimitlessTool({
			name: 'pipeline_review',
			description: `Start the PR's current retained review, or return it when one already exists, including from another conversation. This does not continue or restart an existing review. Returns the current operation, which another caller may have advanced; pass it to pipeline_wait. ${lostResponse}`,
			input: ReviewInput,
			output: OperationReceipt,
			execute: (input, context) => execute(context, client.review(input), { mutation: true }),
		}),
		pipeline_continue: defineLimitlessTool({
			name: 'pipeline_continue',
			description: `Ask the retained reviewer to continue after the settled operation \`after\`, such as rechecking the PR's new head or retrying after a repaired failure. The fixed message rechecks the current PR, findings, and CI. Wait for active work to settle first; unconfirmed delivery or unavailable history does not authorize continuation. Returns the successor operation; repeating the same anchor recovers that successor. ${lostResponse}`,
			input: ContinueInput,
			output: OperationReceipt,
			execute: (input, context) => execute(context, client.continue(input), { mutation: true }),
		}),
		pipeline_restart: defineLimitlessTool({
			name: 'pipeline_restart',
			description: `Start a fresh, independent review of the PR of settled operation \`after\`, without the retained reviewer's context. Use only when explicitly asked. Preserves the previous checkout and session. Returns the new operation; repeating the same anchor recovers that successor. ${lostResponse}`,
			input: ContinueInput,
			output: OperationReceipt,
			execute: (input, context) => execute(context, client.restart(input), { mutation: true }),
		}),
		pipeline_wait: defineLimitlessTool({
			name: 'pipeline_wait',
			description:
				"Wait for an operation's native result or input requirement, without model polling. A completed operation returns the reviewer's final message verbatim. Idle alone is not a verdict. Answer permission and input requests through the native session, then wait again. Healthy waits have no overall time limit. If waiting detaches, repeat the same call. Unavailable means retrieval or attribution failed, not that work did not start; inspect the reason and retry the same operation. Waiting never submits or interrupts work.",
			input: OperationInput,
			output: WaitResult,
			execute: (input, context) =>
				execute(context, client.wait(input, context.progress), {
					mutation: false,
					text: waitText,
				}),
		}),
		pipeline_interrupt: defineLimitlessTool({
			name: 'pipeline_interrupt',
			description: `Request a native interrupt of the reviewer's work after operation \`after\` when the user asks. The status reports the interrupt's delivery; even Acknowledged does not prove work stopped. This is not an assistant operation to wait on. Never interrupt merely to stop waiting. Repeating the same anchor recovers the same interrupt. ${lostResponse}`,
			input: ContinueInput,
			output: InterruptReceipt,
			execute: (input, context) => execute(context, client.interrupt(input), { mutation: true }),
		}),
	}
}
