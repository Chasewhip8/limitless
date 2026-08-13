import { tool } from '@opencode-ai/plugin'
import { Effect } from 'effect'
import { toolOperationError } from '../../core/errors'
import { executeTool } from '../../core/tool-boundary'
import { MAX_SLACK_STATUS_CHARS } from './config'
import type { SlackRunner } from './runner'
import {
	SlackAttachFileInput,
	SlackAttachFileResult,
	SlackStatusInput,
	SlackStatusResult,
} from './schema'

export function slackTools(runner: SlackRunner) {
	if (!runner.enabled) return {}
	return {
		slack_attach_file: tool({
			description:
				'Queue a readable local regular file for upload immediately after the active Slack turn’s final response. Relative paths resolve from the current workspace. Reattaching the same path replaces its queued snapshot.',
			args: { path: tool.schema.string().trim().min(1) },
			execute: (args, context) =>
				executeTool(
					'slack_attach_file',
					SlackAttachFileInput,
					SlackAttachFileResult,
					args,
					context,
					(input) =>
						runner
							.attachFile(context.sessionID, input.path, context.directory)
							.pipe(
								Effect.mapError((error) =>
									toolOperationError('slack_attach_file', error.message, error),
								),
							),
				),
		}),
		slack_status: tool({
			description:
				'Append a concise, meaningful milestone to the thinking trace for the active Slack turn. The final response is delivered automatically.',
			args: {
				text: tool.schema.string().trim().min(1).max(MAX_SLACK_STATUS_CHARS),
			},
			execute: (args, context) =>
				executeTool('slack_status', SlackStatusInput, SlackStatusResult, args, context, (input) =>
					runner
						.updateStatus(context.sessionID, input.text)
						.pipe(
							Effect.mapError((error) => toolOperationError('slack_status', error.message, error)),
						),
				),
		}),
	}
}
