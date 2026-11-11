import { Schema } from 'effect'

export class PullRequestUnavailable extends Schema.TaggedError<PullRequestUnavailable>()(
	'PullRequestUnavailable',
	{
		message: Schema.String,
	},
) {}
