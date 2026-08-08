import { tool } from '@opencode-ai/plugin'
import { Effect } from 'effect'
import { toolOperationError } from '../../core/errors'
import { executeTool } from '../../core/tool-boundary'
import { MAX_SLACK_STATUS_CHARS } from './config'
import type { SlackRunner } from './runner'
import { SlackStatusInput, SlackStatusResult } from './schema'

export function slackTools(runner: SlackRunner) {
	if (!runner.enabled) return {}
	return {
		slack_status: tool({
			description:
				'Update the single mutable progress message for the active Slack turn. Use only for concise, meaningful milestones; the final response is delivered automatically.',
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
