import {
	AbsolutePath,
	type OpenCodeClient,
	type Session,
	type SessionInbox,
	SessionMessage,
} from '@opencode/client/effect'
import { Effect, Option, Schema, Stream } from 'effect'
import { failure, nativeRequest } from './client'
import type { SessionIdentity } from './schema'

const Ownership = Schema.Struct({ pipeline: Schema.Struct({ taskId: Schema.String }) })
export const location = (directory: string) => ({ directory: AbsolutePath.make(directory) })

export const validateSession = Effect.fn('OpenCodeWorker.validateSession')(function* (
	session: Session.Info,
	identity: SessionIdentity,
) {
	const owner = Schema.decodeUnknownOption(Ownership)(session.metadata)
	if (
		session.id !== identity.sessionId ||
		session.location.directory !== identity.directory ||
		session.parentID ||
		session.fork ||
		Option.isNone(owner) ||
		owner.value.pipeline.taskId !== identity.taskId
	) {
		return yield* failure(
			'ownership',
			'The native session no longer matches the retained task reference',
		)
	}
	return session
})

export const matchesPrompt = (payload: SessionInbox.UserPayload, prompt: string) =>
	payload.text === prompt &&
	!payload.files?.length &&
	!payload.agents?.length &&
	!payload.skills?.length

export const deliveredMessage = Effect.fn('OpenCodeWorker.deliveredMessage')(function* (
	client: OpenCodeClient,
	sessionID: Session.ID,
	messageId: string,
) {
	return yield* client.session.message
		.get({ sessionID, messageID: SessionMessage.ID.make(messageId) })
		.pipe(
			Effect.catchTag('MessageNotFoundError', () => Effect.void),
			nativeRequest,
		)
})

export const admissionInJournal = Effect.fn('OpenCodeWorker.admissionInJournal')(function* (
	client: OpenCodeClient,
	sessionID: Session.ID,
	messageId: string,
) {
	return yield* client.experimental.session.log({ sessionID, follow: false }).pipe(
		Stream.take(100_001),
		Stream.filter(
			(event) =>
				event.type === 'session.inbox.enqueued' &&
				event.data.sessionID === sessionID &&
				event.data.inboxID === messageId,
		),
		Stream.runHead,
		nativeRequest,
	)
})

export const wasCancelled = Effect.fn('OpenCodeWorker.wasCancelled')(function* (
	client: OpenCodeClient,
	sessionID: Session.ID,
	messageId: string,
) {
	const event = yield* client.experimental.session.log({ sessionID, follow: false }).pipe(
		Stream.take(100_001),
		Stream.filter(
			(event) =>
				event.type === 'session.inbox.cancelled' &&
				event.data.sessionID === sessionID &&
				event.data.inboxID === messageId,
		),
		Stream.runHead,
		nativeRequest,
	)
	return Option.isSome(event)
})
