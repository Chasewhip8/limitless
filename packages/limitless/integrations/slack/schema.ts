import { Schema } from 'effect'
import { MAX_SLACK_STATUS_CHARS } from './config'

export const SlackImageMime = Schema.Union([
	Schema.Literal('image/png'),
	Schema.Literal('image/jpeg'),
	Schema.Literal('image/webp'),
	Schema.Literal('image/gif'),
])
export type SlackImageMime = typeof SlackImageMime.Type

export const SlackFile = Schema.Struct({
	id: Schema.NonEmptyString,
	name: Schema.optional(Schema.String),
	title: Schema.optional(Schema.String),
	mimetype: Schema.optional(Schema.String),
	size: Schema.optional(Schema.Number),
	url_private: Schema.optional(Schema.String),
	alt_txt: Schema.optional(Schema.String),
})
export type SlackFile = typeof SlackFile.Type

export const SlackMessage = Schema.Struct({
	ts: Schema.NonEmptyString,
	thread_ts: Schema.optional(Schema.String),
	text: Schema.optional(Schema.String),
	user: Schema.optional(Schema.String),
	bot_id: Schema.optional(Schema.String),
	app_id: Schema.optional(Schema.String),
	files: Schema.optional(Schema.Array(SlackFile)),
})
export type SlackMessage = typeof SlackMessage.Type

export const SlackRepliesResponse = Schema.Struct({
	ok: Schema.optional(Schema.Boolean),
	messages: Schema.optional(Schema.Array(SlackMessage)),
	response_metadata: Schema.optional(
		Schema.Struct({ next_cursor: Schema.optional(Schema.String) }),
	),
})

export const SlackAppMentionInput = Schema.Struct({
	body: Schema.Struct({
		team_id: Schema.NonEmptyString,
		event_id: Schema.NonEmptyString,
	}),
	event: Schema.Struct({
		type: Schema.Literal('app_mention'),
		user: Schema.NonEmptyString,
		text: Schema.String,
		channel: Schema.NonEmptyString,
		ts: Schema.NonEmptyString,
		thread_ts: Schema.optional(Schema.String),
		files: Schema.optional(Schema.Array(SlackFile)),
	}),
})
export type SlackAppMentionInput = typeof SlackAppMentionInput.Type

export const SlackPromptTextPart = Schema.Struct({
	type: Schema.Literal('text'),
	text: Schema.String,
})
export const SlackPromptFilePart = Schema.Struct({
	type: Schema.Literal('file'),
	mime: SlackImageMime,
	filename: Schema.String,
	url: Schema.String,
})
export const SlackPromptPart = Schema.Union([SlackPromptTextPart, SlackPromptFilePart])
export type SlackPromptPart = typeof SlackPromptPart.Type

export const SlackStatusInput = Schema.Struct({
	text: Schema.String.check(
		Schema.makeFilter((value) => {
			const length = value.trim().length
			return length > 0 && length <= MAX_SLACK_STATUS_CHARS
				? true
				: `must contain between 1 and ${MAX_SLACK_STATUS_CHARS} characters`
		}),
	),
})
export type SlackStatusInput = typeof SlackStatusInput.Type

export const SlackStatusResult = Schema.Struct({
	ok: Schema.Literal(true),
	status: Schema.String,
})
export type SlackStatusResult = typeof SlackStatusResult.Type

export const SlackOpenCodeEventEnvelope = Schema.Struct({ type: Schema.String })

export const SlackSessionLifecycleEvent = Schema.Struct({
	type: Schema.Union([Schema.Literal('session.created'), Schema.Literal('session.updated')]),
	properties: Schema.Struct({
		info: Schema.Struct({
			id: Schema.NonEmptyString,
			parentID: Schema.optional(Schema.NonEmptyString),
		}),
	}),
})

export const SlackSessionDeletedEvent = Schema.Struct({
	type: Schema.Literal('session.deleted'),
	properties: Schema.Struct({
		info: Schema.Struct({ id: Schema.NonEmptyString }),
	}),
})

export const SlackSessionIdleEvent = Schema.Struct({
	type: Schema.Literal('session.idle'),
	properties: Schema.Struct({ sessionID: Schema.NonEmptyString }),
})

export const SlackSessionErrorEvent = Schema.Struct({
	type: Schema.Literal('session.error'),
	properties: Schema.Struct({
		sessionID: Schema.optional(Schema.NonEmptyString),
		error: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
	}),
})

export const SlackPermissionAskedEvent = Schema.Struct({
	type: Schema.Literal('permission.asked'),
	properties: Schema.Struct({
		id: Schema.NonEmptyString,
		sessionID: Schema.NonEmptyString,
	}),
})

export const SlackSessionStatusEvent = Schema.Struct({
	type: Schema.Literal('session.status'),
	properties: Schema.Struct({
		sessionID: Schema.NonEmptyString,
		status: Schema.Struct({ type: Schema.Literals(['busy', 'idle', 'retry']) }),
	}),
})

export const SlackOpenCodeEvent = Schema.Union([
	SlackSessionLifecycleEvent,
	SlackSessionDeletedEvent,
	SlackSessionIdleEvent,
	SlackSessionErrorEvent,
	SlackPermissionAskedEvent,
	SlackSessionStatusEvent,
])
export type SlackOpenCodeEvent = typeof SlackOpenCodeEvent.Type
