import { Schema } from 'effect'

export const NotificationEvent = Schema.Union([
	Schema.Literal('complete'),
	Schema.Literal('question'),
])
export type NotificationEvent = typeof NotificationEvent.Type

export const NotificationSessionInfo = Schema.Struct({
	id: Schema.NonEmptyString,
	parentID: Schema.optional(Schema.NonEmptyString),
})
export type NotificationSessionInfo = typeof NotificationSessionInfo.Type

export const NotificationSessionLifecycleEvent = Schema.Struct({
	type: Schema.Union([Schema.Literal('session.created'), Schema.Literal('session.updated')]),
	properties: Schema.Struct({
		info: NotificationSessionInfo,
	}),
})
export type NotificationSessionLifecycleEvent = typeof NotificationSessionLifecycleEvent.Type

export const NotificationSessionDeletedEvent = Schema.Struct({
	type: Schema.Literal('session.deleted'),
	properties: Schema.Struct({
		info: NotificationSessionInfo,
	}),
})
export type NotificationSessionDeletedEvent = typeof NotificationSessionDeletedEvent.Type

export const NotificationSessionStatusEvent = Schema.Struct({
	type: Schema.Literal('session.status'),
	properties: Schema.Struct({
		sessionID: Schema.NonEmptyString,
		status: Schema.Struct({
			type: Schema.String,
		}),
	}),
})
export type NotificationSessionStatusEvent = typeof NotificationSessionStatusEvent.Type

export const NotificationSessionIdleEvent = Schema.Struct({
	type: Schema.Literal('session.idle'),
	properties: Schema.Struct({
		sessionID: Schema.NonEmptyString,
	}),
})
export type NotificationSessionIdleEvent = typeof NotificationSessionIdleEvent.Type

export const NotificationOpenCodeEvent = Schema.Union([
	NotificationSessionLifecycleEvent,
	NotificationSessionDeletedEvent,
	NotificationSessionStatusEvent,
	NotificationSessionIdleEvent,
])
export type NotificationOpenCodeEvent = typeof NotificationOpenCodeEvent.Type

export const NotificationEventEnvelope = Schema.Struct({
	type: Schema.String,
})
export type NotificationEventEnvelope = typeof NotificationEventEnvelope.Type
