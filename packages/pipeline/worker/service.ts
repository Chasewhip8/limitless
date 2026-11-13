import { CapsuleHostRpc, type PreparedSession, type PrepareSession } from '@limitless/capsule/rpc'
import { type OpenCodeClient, Session, SessionMessage } from '@opencode/client/effect'
import { Context, Effect, Layer, Option, Stream } from 'effect'
import { failure, makeConnection, nativeRequest, RequestDeadline, translateError } from './client'
import {
	admissionInJournal,
	deliveredMessage,
	location,
	matchesPrompt,
	wasCancelled,
} from './evidence'
import { readResult } from './result'
import type {
	NativeObservation,
	NativeReference,
	NativeResult,
	SessionIdentity,
	Worker,
	WorkerError,
} from './schema'
import type { SourceSpec } from './source'

const prepareDeadline = '15 minutes'

const owner = (identity: SessionIdentity) => ({ namespace: 'pipeline', id: identity.taskId })

const sessionReference = (identity: SessionIdentity) => ({
	storageId: identity.storageId,
	workspaceId: identity.workspaceId,
	sessionId: identity.sessionId,
	owner: owner(identity),
})

const requirePlaced = Effect.fn('OpenCodeWorker.requirePlaced')(function* (
	placed: PreparedSession,
	identity: SessionIdentity,
) {
	if (
		placed.workspaceId !== identity.workspaceId ||
		placed.sessionId !== identity.sessionId ||
		placed.directory !== identity.directory
	) {
		return yield* failure(
			'ownership',
			'The Capsule host placed the session outside the retained task assignment',
		)
	}
})

const make = Effect.gen(function* () {
	const connect = yield* makeConnection
	const capsule = (client: OpenCodeClient, worker: Worker) => {
		const host = client.rpc(CapsuleHostRpc)
		const options = { location: location(worker.controlDirectory) }
		return {
			info: () => host.info({}, options).pipe(nativeRequest),
			prepareSession: (input: typeof PrepareSession.Encoded) =>
				host
					.prepareSession(input, options)
					.pipe(nativeRequest, Effect.provideService(RequestDeadline, prepareDeadline)),
			getSession: (identity: SessionIdentity) =>
				host.getSession(sessionReference(identity), options).pipe(nativeRequest),
		}
	}

	/** Proves the retained identity without mutating it, whatever the Capsule's phase; it never prepares again. */
	const provePlacement = Effect.fn('OpenCodeWorker.provePlacement')(function* (
		client: OpenCodeClient,
		worker: Worker,
		identity: SessionIdentity,
	) {
		const placement = yield* capsule(client, worker).getSession(identity)
		yield* requirePlaced(placement, identity)
		return placement
	})

	const ready = Effect.fn('OpenCodeWorker.ready')(function* (worker: Worker) {
		const client = yield* connect(worker)
		const info = yield* client.server.info().pipe(nativeRequest)
		if (info.version !== worker.openCodeVersion)
			return yield* failure('incompatible', 'OpenCode version does not match worker enrollment')
		const { data: agents } = yield* client.agent
			.list({ location: location(worker.controlDirectory) })
			.pipe(nativeRequest)
		if (!agents.some((agent) => agent.id === 'review' && agent.mode !== 'subagent')) {
			return yield* failure('incompatible', 'The worker must provide a primary review agent')
		}
		return yield* capsule(client, worker).info()
	}, Effect.mapError(translateError))

	/** Idempotently creates the Capsule, workspace and session; retrying an identical request is safe. */
	const prepareSession = Effect.fn('OpenCodeWorker.prepareSession')(function* (
		worker: Worker,
		identity: SessionIdentity,
		request: { readonly source: SourceSpec; readonly pr: string },
	) {
		const client = yield* connect(worker)
		const placed = yield* capsule(client, worker).prepareSession({
			...sessionReference(identity),
			source: request.source,
			agent: 'review',
			metadata: { pipeline: { taskId: identity.taskId, pr: request.pr } },
		})
		yield* requirePlaced(placed, identity)
	}, Effect.mapError(translateError))

	const requirePlacement = Effect.fn('OpenCodeWorker.requirePlacement')(function* (
		worker: Worker,
		identity: SessionIdentity,
	) {
		const client = yield* connect(worker)
		return yield* provePlacement(client, worker, identity)
	}, Effect.mapError(translateError))

	const findAdmission = Effect.fn('OpenCodeWorker.findAdmission')(function* (
		worker: Worker,
		identity: SessionIdentity,
		messageId: string,
		prompt: string,
	) {
		const client = yield* connect(worker)
		yield* provePlacement(client, worker, identity)
		const sessionID = Session.ID.make(identity.sessionId)
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

	/** Prove placement and persist Unconfirmed before calling. An unconfirmed response must be reconciled, never automatically reposted. */
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
		yield* provePlacement(client, worker, identity)
		const sessionID = Session.ID.make(identity.sessionId)
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
		// A finished job stays listed until its completion notice is admitted, which wakes the session again.
		const backgroundJobs = jobs.length
		if (active[sessionID] !== undefined || backgroundJobs > 0)
			return { _tag: 'Running', backgroundJobs }
		if (inbox.length > 0) return { _tag: 'Pending', messageIds: inbox.map((item) => item.id) }
		if (messageId === undefined) return { _tag: 'Idle' }
		const delivered = yield* deliveredMessage(client, sessionID, messageId)
		if (delivered?.id === messageId && delivered.type === 'user') return { _tag: 'Idle' }
		if (yield* wasCancelled(client, sessionID, messageId)) return { _tag: 'InputCancelled' }
		return { _tag: 'NotObserved' }
	}, Effect.mapError(translateError))

	/** Reads the settled outcome of exactly this admitted input from durable history; live input requests stay with `observe`. */
	const result = Effect.fn('OpenCodeWorker.result')(function* (
		worker: Worker,
		identity: SessionIdentity,
		messageId: string,
	): Effect.fn.Return<NativeResult, WorkerError> {
		const client = yield* connect(worker)
		yield* provePlacement(client, worker, identity)
		return yield* readResult(client, Session.ID.make(identity.sessionId), messageId)
	}, Effect.mapError(translateError))

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
		prepareSession,
		requirePlacement,
		admit,
		findAdmission,
		interrupt,
		observe,
		result,
		watch,
	}
})

export class OpenCodeWorker extends Context.Service<OpenCodeWorker, Effect.Success<typeof make>>()(
	'pipeline/worker/OpenCodeWorker',
) {}
export const openCodeWorkerLayer = Layer.effect(OpenCodeWorker, make)
