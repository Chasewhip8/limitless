import {
	AbsolutePath,
	type OpenCodeClient,
	type Session,
	type SessionInbox,
	SessionMessage,
} from '@opencode/client/effect'
import { Effect, Option, Stream } from 'effect'
import { failure, nativeRequest, RequestDeadline } from './client'

export const location = (directory: string) => ({ directory: AbsolutePath.make(directory) })

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
			nativeRequest('delivered_message'),
		)
})

type LogInput = Parameters<OpenCodeClient['experimental']['session']['log']>[0]
type LogItem = Stream.Success<ReturnType<OpenCodeClient['experimental']['session']['log']>>
export type DurableEvent = Exclude<LogItem, { readonly type: 'log.synced' }>
export type LogSeq = NonNullable<LogInput['after']>

const replayDeadline = '2 minutes'

/**
 * Folds the session's finite durable log after `after` until `visit` returns a value. Without a value, the
 * replay must reach its sync marker, whose sequence is the watermark for a later incremental replay, so
 * absence is never inferred from a partial or truncated replay.
 */
export const replayLog = Effect.fn('OpenCodeWorker.replayLog')(function* <A>(
	client: OpenCodeClient,
	sessionID: Session.ID,
	visit: (event: DurableEvent) => A | undefined,
	after?: LogSeq,
) {
	let found: A | undefined
	let synced: { readonly seq?: LogSeq | undefined } | undefined
	yield* client.experimental.session
		.log({ sessionID, follow: false, ...(after === undefined ? {} : { after }) })
		.pipe(
			Stream.runForEachWhile((item) =>
				Effect.sync(() => {
					if (item.type === 'log.synced') {
						synced = item
						return false
					}
					found = visit(item)
					return found === undefined
				}),
			),
			nativeRequest('history'),
			Effect.provideService(RequestDeadline, replayDeadline),
		)
	if (found !== undefined) return { found: Option.some(found), seq: undefined }
	if (synced === undefined)
		return yield* failure(
			'unavailable',
			'The native session history replay ended before it was complete',
			{ reason: 'incomplete', stage: 'history' },
		)
	return { found: Option.none<A>(), seq: synced.seq ?? after }
})

export const admissionInJournal = Effect.fn('OpenCodeWorker.admissionInJournal')(function* (
	client: OpenCodeClient,
	sessionID: Session.ID,
	messageId: string,
) {
	const { found } = yield* replayLog(client, sessionID, (event) =>
		event.type === 'session.inbox.enqueued' &&
		event.data.sessionID === sessionID &&
		event.data.inboxID === messageId
			? event
			: undefined,
	)
	return found
})

export const wasCancelled = Effect.fn('OpenCodeWorker.wasCancelled')(function* (
	client: OpenCodeClient,
	sessionID: Session.ID,
	messageId: string,
) {
	const { found } = yield* replayLog(client, sessionID, (event) =>
		event.type === 'session.inbox.cancelled' &&
		event.data.sessionID === sessionID &&
		event.data.inboxID === messageId
			? event
			: undefined,
	)
	return Option.isSome(found)
})
