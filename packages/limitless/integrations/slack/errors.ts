import { Schema } from 'effect'

export class SlackIntegrationError extends Schema.TaggedErrorClass<SlackIntegrationError>()(
	'SlackIntegrationError',
	{
		operation: Schema.String,
		message: Schema.String,
	},
) {}

export function slackIntegrationError(operation: string, message: string) {
	return new SlackIntegrationError({ operation, message })
}
