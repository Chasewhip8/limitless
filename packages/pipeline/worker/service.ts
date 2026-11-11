import { Agent, Session, SessionMessage } from '@opencode/client/effect'
import { Context, Effect, Layer, Option, Stream } from 'effect'
import { failure, makeConnection, nativeRequest, translateError } from './client'
import {
	admissionInJournal,
	deliveredMessage,
	location,
	matchesPrompt,
	validateSession,
	wasCancelled,
} from './evidence'
import type {
	NativeObservation,
	NativeReference,
	SessionIdentity,
	Worker,
	WorkerError,
} from './schema'
import { makeWorkspaces } from './workspace'

const make = Effect.gen(function* () {
	const connect = yield* makeConnection
	const workspaces = yield* makeWorkspaces
	const ready = Effect.fn('OpenCodeWorker.ready')(function* (worker: Worker) {
		const client = yield* connect(worker)
		const info = yield* client.server.info().pipe(nativeRequest)
		if (info.version !== worker.openCodeVersion)
			return yield* failure('incompatible', 'OpenCode version does not match worker enrollment')
		const { data: agents } = yield* client.agent.list().pipe(nativeRequest)
		if (!agents.some((agent) => agent.id === 'review' && agent.mode !== 'subagent')) {
			return yield* failure('incompatible', 'The worker must provide a primary review agent')
		}
		yield* workspaces.check(worker)
	}, Effect.mapError(translateError))

	const createSession = Effect.fn('OpenCodeWorker.createSession')(function* (
		worker: Worker,
		identity: SessionIdentity,
	) {
		const client = yield* connect(worker)
		const session = yield* client.session
			.create({
				id: Session.ID.make(identity.sessionId),
				location: location(identity.directory),
				agent: Agent.ID.make('review'),
				metadata: { pipeline: { taskId: identity.taskId, pr: identity.pr } },
			})
			.pipe(nativeRequest)
		yield* validateSession(session, identity)
		if (session.agent !== 'review')
			return yield* failure('ownership', 'Initial review session has a different agent')
	}, Effect.mapError(translateError))

	const requireSession = Effect.fn('OpenCodeWorker.requireSession')(function* (
		worker: Worker,
		identity: SessionIdentity,
	) {
		const client = yield* connect(worker)
		const session = yield* client.session
			.get({ sessionID: Session.ID.make(identity.sessionId) })
			.pipe(nativeRequest)
		yield* validateSession(session, identity)
	}, Effect.mapError(translateError))

	const findAdmission = Effect.fn('OpenCodeWorker.findAdmission')(function* (
		worker: Worker,
		identity: SessionIdentity,
		messageId: string,
		prompt: string,
	) {
		const client = yield* connect(worker)
		const sessionID = Session.ID.make(identity.sessionId)
		const session = yield* client.session.get({ sessionID }).pipe(nativeRequest)
		yield* validateSession(session, identity)
		const reference: NativeReference = { sessionId: identity.sessionId, messageId }
		const inbox = yield* client.session.inbox.list({ sessionID }).pipe(nativeRequest)
		const pending = inbox.find((item) => item.id === messageId)
		if (pending !== undefined) {
			if (
				pending.sessionID !== sessionID ||
				pending.type !== 'user' ||
				!matchesPrompt(pending.payload, prompt)
			) {
				return yield* failure(
					'ownership',
					'Native input identity has a different immutable payload',
				)
			}
			return reference
		}
		const delivered = yield* deliveredMessage(client, sessionID, messageId)
		if (delivered !== undefined) {
			if (
				delivered.id !== messageId ||
				delivered.type !== 'user' ||
				!matchesPrompt(delivered, prompt)
			) {
				return yield* failure(
					'ownership',
					'Native message identity has a different immutable payload',
				)
			}
			return reference
		}
		const original = yield* admissionInJournal(client, sessionID, messageId)
		if (Option.isNone(original)) return undefined
		const event = original.value
		if (
			event.type !== 'session.inbox.enqueued' ||
			event.data.sessionID !== sessionID ||
			event.data.item.type !== 'user' ||
			!matchesPrompt(event.data.item.payload, prompt)
		) {
			return yield* failure(
				'ownership',
				'Original native admission has a different immutable payload',
			)
		}
		return reference
	}, Effect.mapError(translateError))

	/** Persist Unconfirmed before calling. An unconfirmed response must be reconciled, never automatically reposted. */
	const admit = Effect.fn('OpenCodeWorker.admit')(function* (
		worker: Worker,
		identity: SessionIdentity,
		messageId: string,
		prompt: string,
	) {
		const client = yield* connect(worker)
		const sessionID = Session.ID.make(identity.sessionId)
		const accepted = yield* client.session
			.prompt({
				sessionID,
				id: SessionMessage.ID.make(messageId),
				text: prompt,
				delivery: 'queue',
			})
			.pipe(nativeRequest)
		if (
			accepted.id !== messageId ||
			accepted.sessionID !== sessionID ||
			!matchesPrompt(accepted.payload, prompt)
		) {
			return yield* failure(
				'ownership',
				'Native admission response does not match the dispatched input',
			)
		}
		return { sessionId: identity.sessionId, messageId } satisfies NativeReference
	}, Effect.mapError(translateError))

	/** Acknowledges native delivery only. Unknown interruptions cannot be reconciled from idle or automatically retried. */
	const interrupt = Effect.fn('OpenCodeWorker.interrupt')(function* (
		worker: Worker,
		identity: SessionIdentity,
	) {
		const client = yield* connect(worker)
		yield* client.session
			.interrupt({ sessionID: Session.ID.make(identity.sessionId), resume: false })
			.pipe(nativeRequest)
		return { sessionId: identity.sessionId } satisfies NativeReference
	}, Effect.mapError(translateError))

	const observe = Effect.fn('OpenCodeWorker.observe')(function* (
		worker: Worker,
		identity: SessionIdentity,
		messageId?: string,
	): Effect.fn.Return<NativeObservation, WorkerError> {
		const client = yield* connect(worker)
		const sessionID = Session.ID.make(identity.sessionId)
		const session = yield* client.session.get({ sessionID }).pipe(nativeRequest)
		yield* validateSession(session, identity)
		const permissions = yield* client.permission.list({ sessionID }).pipe(nativeRequest)
		const forms = yield* client.session.form.list({ sessionID }).pipe(nativeRequest)
		const pendingForms = forms.filter((form) => form.sessionID === sessionID)
		if (permissions.length > 0 || pendingForms.length > 0)
			return {
				_tag: 'NeedsInput',
				permissionIds: permissions.map((request) => request.id),
				formIds: pendingForms.map((form) => form.id),
			}
		const inbox = yield* client.session.inbox.list({ sessionID }).pipe(nativeRequest)
		const active = yield* client.session.active().pipe(nativeRequest)
		const jobs = yield* client.experimental.job
			.list({ sessionID, descendants: true })
			.pipe(nativeRequest)
		const backgroundJobs = jobs.filter((job) => job.status === 'running').length
		if (active[sessionID] !== undefined || backgroundJobs > 0)
			return { _tag: 'Running', backgroundJobs }
		if (inbox.length > 0) return { _tag: 'Pending', messageIds: inbox.map((item) => item.id) }
		if (messageId === undefined) return { _tag: 'Idle' }
		const delivered = yield* deliveredMessage(client, sessionID, messageId)
		if (delivered?.id === messageId && delivered.type === 'user') return { _tag: 'Idle' }
		if (yield* wasCancelled(client, sessionID, messageId)) return { _tag: 'InputCancelled' }
		return { _tag: 'NotObserved' }
	}, Effect.mapError(translateError))

	// Helper probes emit shell.exited themselves; session events avoid rescheduling those probes.
	const watch = (worker: Worker) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const client = yield* connect(worker)
				return client.event
					.subscribe({
						types: [
							'session.execution.started',
							'session.execution.succeeded',
							'session.execution.failed',
							'session.execution.interrupted',
							'session.inbox.enqueued',
							'session.inbox.delivered',
							'session.inbox.cancelled',
							'session.idle',
							'session.shell.ended',
							'session.tool.success',
							'session.tool.failed',
							'permission.asked',
							'permission.replied',
							'form.created',
							'form.replied',
							'form.cancelled',
							'agent.updated',
							'plugin.updated',
						],
					})
					.pipe(Stream.map(() => undefined))
			}),
		).pipe(Stream.mapError(translateError))

	return {
		ready,
		prepare: workspaces.prepare,
		createSession,
		requireSession,
		admit,
		findAdmission,
		interrupt,
		observe,
		watch,
	}
})

export class OpenCodeWorker extends Context.Service<OpenCodeWorker, Effect.Success<typeof make>>()(
	'pipeline/worker/OpenCodeWorker',
) {}
export const openCodeWorkerLayer = Layer.effect(OpenCodeWorker, make)
