import { Schema } from 'effect'

export const NotificationEvent = Schema.Union([
	Schema.Literal('complete'),
	Schema.Literal('permission'),
	Schema.Literal('question'),
])
export type NotificationEvent = typeof NotificationEvent.Type

export const NotificationFormCreated = Schema.Struct({
	type: Schema.Literal('form.created'),
	data: Schema.Struct({
		form: Schema.Struct({ sessionID: Schema.NonEmptyString }),
	}),
})

export const NotificationPermissionAsked = Schema.Struct({
	type: Schema.Literal('permission.asked'),
	data: Schema.Struct({ sessionID: Schema.NonEmptyString }),
})

export const NotificationExecutionTerminal = Schema.Struct({
	type: Schema.Union([
		Schema.Literal('session.execution.succeeded'),
		Schema.Literal('session.execution.failed'),
		Schema.Literal('session.execution.interrupted'),
	]),
	data: Schema.Struct({ sessionID: Schema.NonEmptyString }),
})

export const NotificationOpenCodeEvent = Schema.Union([
	NotificationPermissionAsked,
	NotificationFormCreated,
	NotificationExecutionTerminal,
])
export type NotificationOpenCodeEvent = typeof NotificationOpenCodeEvent.Type

export const NotificationEventEnvelope = Schema.Struct({ type: Schema.String })

export class NotificationSessionLookupError extends Schema.TaggedError<NotificationSessionLookupError>()(
	'NotificationSessionLookupError',
	{ message: Schema.String },
) {}

export const NotificationSession = Schema.Struct({ parentID: Schema.optional(Schema.String) })
export type NotificationSession = typeof NotificationSession.Type
