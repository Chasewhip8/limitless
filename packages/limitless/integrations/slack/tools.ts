import { Effect } from 'effect'
import { toolOperationError } from '../../core/errors'
import { ToolExecutionContext } from '../../core/execution'
import {
	defineLimitlessTool,
	encodeToolFailure,
	type ToolExecutor,
} from '../../plugin/tool-boundary'
import type { SlackRunner } from './runner'
import {
	SlackAttachFileInput,
	SlackAttachFileResult,
	SlackStatusInput,
	SlackStatusResult,
} from './schema'

export function slackTools(executeTool: ToolExecutor, runner: SlackRunner) {
	if (!runner.enabled) return {}
	return {
		slack_attach_file: defineLimitlessTool({
			name: 'slack_attach_file',
			description:
				'Queue a readable local regular file for upload immediately after the active Slack turn’s final response. Relative paths resolve from the current workspace. Reattaching the same path replaces its queued snapshot.',
			input: SlackAttachFileInput,
			output: SlackAttachFileResult,
			execute: (args, context) =>
				executeTool(
					'slack_attach_file',
					args,
					context,
					(input) =>
						Effect.gen(function* () {
							const execution = yield* ToolExecutionContext
							return yield* runner
								.attachFile(context.sessionID, input.path, execution.projectRoot)
								.pipe(
									Effect.mapError((error) =>
										toolOperationError('slack_attach_file', error.message, error),
									),
								)
						}),
					encodeToolFailure,
				),
		}),
		slack_status: defineLimitlessTool({
			name: 'slack_status',
			description:
				'Append a concise, meaningful milestone to the thinking trace for the active Slack turn. The final response is delivered automatically.',
			input: SlackStatusInput,
			output: SlackStatusResult,
			execute: (args, context) =>
				executeTool(
					'slack_status',
					args,
					context,
					(input) =>
						runner
							.updateStatus(context.sessionID, input.text)
							.pipe(
								Effect.mapError((error) =>
									toolOperationError('slack_status', error.message, error),
								),
							),
					encodeToolFailure,
				),
		}),
	}
}
