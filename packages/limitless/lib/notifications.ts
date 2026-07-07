import { Schema } from 'effect'

export const NotificationEvent = Schema.Union([
	Schema.Literal('complete'),
	Schema.Literal('question'),
])
export type NotificationEvent = typeof NotificationEvent.Type

export const NotificationOptionsBlock = Schema.Struct({
	enable: Schema.optional(Schema.Boolean),
	enabled: Schema.optional(Schema.Boolean),
	command: Schema.optional(Schema.Array(Schema.String)),
	events: Schema.optional(
		Schema.Struct({
			complete: Schema.optional(Schema.Boolean),
			question: Schema.optional(Schema.Boolean),
		}),
	),
	includeChildSessions: Schema.optional(Schema.Boolean),
	timeoutMs: Schema.optional(Schema.Finite),
})
export type NotificationOptionsBlock = typeof NotificationOptionsBlock.Type

export type NotificationConfig = {
	readonly enabled: boolean
	readonly command: readonly [string, ...string[]] | null
	readonly events: Readonly<Record<NotificationEvent, boolean>>
	readonly includeChildSessions: boolean
	readonly timeoutMs: number
}
