import { Effect, Option, Ref, Schema } from 'effect'
import { schemaErrorMessage } from '../../lib/guards'
import type { NotificationConfig } from './config'
import { runNotificationCommand } from './events'
import type { NotificationEvent } from './schema'
import { NotificationEventEnvelope, NotificationOpenCodeEvent } from './schema'

export const createNotificationRunner = Effect.fn('createNotificationRunner')(function* (
	config: NotificationConfig,
) {
	const state = yield* Ref.make({
		childSessionIds: new Set<string>(),
		completedIdleSessionIds: new Set<string>(),
	})
	const handleDecodedEvent = Effect.fn('NotificationRunner.handleDecodedEvent')(function* (
		event: NotificationOpenCodeEvent,
	) {
		switch (event.type) {
			case 'session.created':
			case 'session.updated':
				yield* Ref.update(state, (current) => {
					const childSessionIds = new Set(current.childSessionIds)
					if (event.properties.info.parentID !== undefined)
						childSessionIds.add(event.properties.info.id)
					else childSessionIds.delete(event.properties.info.id)
					return { ...current, childSessionIds }
				})
				return
			case 'session.deleted':
				yield* Ref.update(state, (current) => {
					const childSessionIds = new Set(current.childSessionIds)
					const completedIdleSessionIds = new Set(current.completedIdleSessionIds)
					childSessionIds.delete(event.properties.info.id)
					completedIdleSessionIds.delete(event.properties.info.id)
					return { childSessionIds, completedIdleSessionIds }
				})
				return
			case 'session.status':
				if (event.properties.status.type !== 'busy') return
				yield* Ref.update(state, (current) => {
					const completedIdleSessionIds = new Set(current.completedIdleSessionIds)
					completedIdleSessionIds.delete(event.properties.sessionID)
					return { ...current, completedIdleSessionIds }
				})
				return
			case 'session.idle': {
				const shouldNotify = yield* Ref.modify(state, (current) => {
					const sessionID = event.properties.sessionID
					if (!config.includeChildSessions && current.childSessionIds.has(sessionID))
						return [false, current]
					if (current.completedIdleSessionIds.has(sessionID)) return [false, current]
					const completedIdleSessionIds = new Set(current.completedIdleSessionIds)
					completedIdleSessionIds.add(sessionID)
					return [true, { ...current, completedIdleSessionIds }]
				})
				if (shouldNotify) yield* runNotificationCommand(config, 'complete')
				return
			}
		}
	})
	return {
		notify: (event: NotificationEvent) => runNotificationCommand(config, event),
		handleEvent: (event: unknown) => {
			if (!config.enabled) return Effect.void
			const envelope = Schema.decodeUnknownOption(NotificationEventEnvelope)(event)
			if (
				Option.isNone(envelope) ||
				![
					'session.created',
					'session.updated',
					'session.deleted',
					'session.status',
					'session.idle',
				].includes(envelope.value.type)
			)
				return Effect.void
			return Schema.decodeUnknownEffect(NotificationOpenCodeEvent)(event).pipe(
				Effect.matchEffect({
					onFailure: (error) =>
						Effect.logWarning(
							`[limitless] ignored malformed ${envelope.value.type} notification event: ${schemaErrorMessage(error)}`,
						),
					onSuccess: handleDecodedEvent,
				}),
			)
		},
	}
})
