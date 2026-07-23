import { Effect, Option, Schema } from 'effect'
import { schemaErrorMessage } from '../../lib/guards'
import type { NotificationConfig } from './config'
import { runNotificationCommand } from './events'
import {
	NotificationEventEnvelope,
	NotificationOpenCodeEvent,
	type NotificationSession,
	type NotificationSessionLookupError,
} from './schema'

export type NotificationSessionLookup = (
	sessionID: string,
) => Effect.Effect<NotificationSession, NotificationSessionLookupError>

export const createNotificationRunner = Effect.fn('createNotificationRunner')(function* (
	config: NotificationConfig,
) {
	const handleDecodedEvent = Effect.fn('NotificationRunner.handleDecodedEvent')(function* (
		event: NotificationOpenCodeEvent,
		lookupSession: NotificationSessionLookup,
	) {
		if (event.type === 'permission.v2.asked') {
			yield* runNotificationCommand(config, 'permission')
			return
		}
		if (event.type === 'question.v2.asked') {
			yield* runNotificationCommand(config, 'question')
			return
		}
		const session = yield* lookupSession(event.data.sessionID).pipe(
			Effect.catch((error) =>
				Effect.logError(`[limitless] notification session lookup failed: ${error.message}`).pipe(
					Effect.as<NotificationSession>({}),
				),
			),
		)
		if (!config.includeChildSessions && session.parentID !== undefined) return
		yield* runNotificationCommand(config, 'complete')
	})

	return {
		notify: runNotificationCommand.bind(null, config),
		handleEvent: (event: unknown, lookupSession: NotificationSessionLookup) => {
			if (!config.enabled) return Effect.void
			const envelope = Schema.decodeUnknownOption(NotificationEventEnvelope)(event)
			if (
				Option.isNone(envelope) ||
				![
					'permission.v2.asked',
					'question.v2.asked',
					'session.execution.succeeded',
					'session.execution.failed',
					'session.execution.interrupted',
				].includes(envelope.value.type)
			)
				return Effect.void
			return Schema.decodeUnknownEffect(NotificationOpenCodeEvent)(event).pipe(
				Effect.matchEffect({
					onFailure: (error) =>
						Effect.logWarning(
							`[limitless] ignored malformed ${envelope.value.type} notification event: ${schemaErrorMessage(error)}`,
						),
					onSuccess: (decoded) => handleDecodedEvent(decoded, lookupSession),
				}),
			)
		},
	}
})
