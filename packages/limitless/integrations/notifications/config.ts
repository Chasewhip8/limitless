import { Effect, Schema } from 'effect'
import { PositiveFiniteTimeout, TrimmedNonEmptyString } from '../../core/command'
import { schemaErrorMessage } from '../../lib/guards'

export const NotificationCommand = Schema.TupleWithRest(Schema.Tuple([TrimmedNonEmptyString]), [
	Schema.String,
])
export const NotificationEventOptions = Schema.Struct({
	complete: Schema.optional(Schema.Boolean),
	permission: Schema.optional(Schema.Boolean),
	question: Schema.optional(Schema.Boolean),
})
export const NotificationOptionsBlock = Schema.Struct({
	enable: Schema.optional(Schema.Boolean),
	enabled: Schema.optional(Schema.Boolean),
	command: Schema.optional(NotificationCommand),
	events: Schema.optional(NotificationEventOptions),
	includeChildSessions: Schema.optional(Schema.Boolean),
	timeoutMs: Schema.optional(PositiveFiniteTimeout),
})
export const NotificationPluginOptions = Schema.Struct({
	notifications: Schema.optional(NotificationOptionsBlock),
})
export const NotificationEventSettings = Schema.Struct({
	complete: Schema.Boolean,
	permission: Schema.Boolean,
	question: Schema.Boolean,
})
const NotificationConfigFields = Schema.Struct({
	enabled: Schema.Boolean,
	command: Schema.NullOr(NotificationCommand),
	events: NotificationEventSettings,
	includeChildSessions: Schema.Boolean,
	timeoutMs: PositiveFiniteTimeout,
})
export const NotificationConfig = NotificationConfigFields.check(
	Schema.makeFilter<typeof NotificationConfigFields.Type>(
		(config) =>
			!config.enabled ||
			config.command !== null ||
			'an enabled notification configuration requires a command',
	),
)
export type NotificationConfig = typeof NotificationConfig.Type
export class NotificationConfigError extends Schema.TaggedError<NotificationConfigError>()(
	'NotificationConfigError',
	{ message: Schema.String },
) {}

export const DEFAULT_NOTIFICATION_TIMEOUT_MS = 5_000
const defaultEvents = NotificationEventSettings.make({
	complete: true,
	permission: true,
	question: true,
})
export const DISABLED_NOTIFICATION_CONFIG = NotificationConfig.make({
	enabled: false,
	command: null,
	events: defaultEvents,
	includeChildSessions: false,
	timeoutMs: DEFAULT_NOTIFICATION_TIMEOUT_MS,
})

export const normalizeNotificationConfig = Effect.fn('normalizeNotificationConfig')(function* (
	options: unknown,
) {
	if (options === undefined) return DISABLED_NOTIFICATION_CONFIG
	const decoded = yield* Schema.decodeUnknownEffect(NotificationPluginOptions)(options).pipe(
		Effect.mapError((error) => new NotificationConfigError({ message: schemaErrorMessage(error) })),
	)
	if (decoded.notifications === undefined) return DISABLED_NOTIFICATION_CONFIG
	const notifications = decoded.notifications
	const command = notifications.command ?? null
	return NotificationConfig.make({
		enabled: (notifications.enable ?? notifications.enabled ?? false) && command !== null,
		command,
		events: NotificationEventSettings.make({
			complete: notifications.events?.complete ?? defaultEvents.complete,
			permission: notifications.events?.permission ?? defaultEvents.permission,
			question: notifications.events?.question ?? defaultEvents.question,
		}),
		includeChildSessions: notifications.includeChildSessions ?? false,
		timeoutMs: notifications.timeoutMs ?? DEFAULT_NOTIFICATION_TIMEOUT_MS,
	})
})
