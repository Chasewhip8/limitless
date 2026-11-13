import { type OpenCodeClient, Session, SessionMessage } from '@opencode/client/effect'
import { Effect, Option } from 'effect'
import { nativeRequest } from './client'
import { type DurableEvent, type LogSeq, replayLog } from './evidence'
import type { NativeResult, WorkerError } from './schema'

type Completion = { readonly _tag: 'Respond'; readonly assistantMessageId: string }
type Verdict = NativeResult | Completion
type End = NativeResult | { readonly _tag: 'Candidate'; readonly completion: Completion }

type Owner = 'target' | 'foreign'
type InboxItem = {
	readonly type: string
	delivery: string
	/** A background completion notice: `shell:<shellID>`, `subagent:<childID>`, or `unknown` for another source. */
	readonly notice: string | undefined
}

const unavailable = (message: string) => ({ _tag: 'Unavailable', message }) satisfies NativeResult
const pending = { _tag: 'Pending' } satisfies NativeResult

type Metadata = { readonly [key: string]: unknown } | undefined

const launchesBackground = (metadata: Metadata) =>
	metadata?.status === 'running' || typeof metadata?.jobID === 'string'

/**
 * Background work a tool result launched. Only the native shell and subagent tools carry the identities their
 * completion notices repeat; any other background launch is unsupported.
 */
const backgroundLaunch = (name: string | undefined, metadata: Metadata) => {
	if (!launchesBackground(metadata)) return undefined
	if (name === 'shell' && typeof metadata?.shellID === 'string') return `shell:${metadata.shellID}`
	if (name === 'subagent' && typeof metadata?.sessionID === 'string')
		return `subagent:${metadata.sessionID}`
	return 'unsupported'
}

// https://github.com/anomalyco/opencode/blob/v2.2.7/packages/core/src/session/subagent-completion.ts
// https://github.com/anomalyco/opencode/blob/v2.2.7/packages/core/src/shell/result.ts
const completionNotice = (metadata: Metadata) => {
	const source = metadata?.source
	if (source === 'subagent' && typeof metadata?.childID === 'string')
		return `subagent:${metadata.childID}`
	if (source === 'shell' && typeof metadata?.shellID === 'string')
		return `shell:${metadata.shellID}`
	return typeof source === 'string' ? 'unknown' : undefined
}

/**
 * Folds durable session history into the outcome of one delivered input. OpenCode records no link from an
 * input to its execution, so the operation opens at the target's delivery and follows positive causal
 * evidence only:
 * - An execution terminal covers a whole busy period; the next independent delivery separates queued turns.
 * - Background shell and subagent launches oblige the operation to continue after its busy period ends,
 *   until their completion notices are delivered and a later step settles.
 * - A shutdown suspends the operation for native recovery rather than ending it.
 * - The final step must positively end the turn: a step with locally executed tools or an output-limit
 *   stop is always continued natively, so its text is a preamble, not a response.
 * - Steered user input, foreign or unattributed notices, unsupported background launches, and independent
 *   input while obligations remain make the final response unattributable.
 * A success with no obligations becomes a candidate that the next independent delivery confirms, or that
 * the caller confirms against live native state at the end of the replay.
 */
const foldResult = (messageId: string) => {
	const inbox = new Map<string, InboxItem>()
	const outstanding = new Map<string, Owner[]>()
	const toolNames = new Map<string, string>()
	const children = new Set<string>()
	let phase: 'before' | 'running' | 'waiting' | 'candidate' = 'before'
	let enqueued = false
	let ambiguous = false
	/** A recovered shutdown may promote other input before it continues this turn. */
	let recovering = false
	let blocked: string | undefined
	let step:
		| { id: string; settled: 'open' | 'ended' | 'failed'; finish?: string; continues: boolean }
		| undefined
	let candidate: Completion | undefined

	const obligations = () => [...outstanding.values()].some((owners) => owners.includes('target'))

	// https://github.com/anomalyco/opencode/blob/v2.2.7/packages/core/src/session/runner/step.ts
	// https://github.com/anomalyco/opencode/blob/v2.2.7/packages/core/src/session/runner/publish-llm-event.ts
	const settle = (): Verdict => {
		if (blocked !== undefined) return unavailable(blocked)
		if (ambiguous)
			return unavailable(
				'Other steered input or background notices entered this turn, so its final response cannot be attributed',
			)
		if (recovering)
			return unavailable(
				'A shutdown interrupted this turn, and its recovery did not settle another response',
			)
		if (step === undefined) return unavailable('No native response settled after this turn’s input')
		if (step.settled !== 'ended' || step.continues || step.finish === 'length')
			return unavailable('The final native step did not settle a response that ends the turn')
		return { _tag: 'Respond', assistantMessageId: step.id }
	}

	const succeeded = (): Verdict | undefined => {
		if (phase !== 'running') return undefined
		if (obligations()) {
			phase = 'waiting'
			return undefined
		}
		const verdict = settle()
		if (verdict._tag !== 'Respond') return verdict
		candidate = verdict
		phase = 'candidate'
		return undefined
	}

	const independent = (): Verdict => {
		if (phase === 'candidate' && candidate !== undefined) return candidate
		if (obligations())
			return unavailable(
				'Independent input arrived while this turn’s background work was still outstanding',
			)
		return settle()
	}

	const resolveNotice = (key: string) => {
		const owners = outstanding.get(key)
		const owner = owners?.shift()
		if (owners?.length === 0) outstanding.delete(key)
		return owner
	}

	const delivered = (id: string): Verdict | undefined => {
		const item = inbox.get(id)
		if (phase === 'before') {
			if (item?.notice !== undefined && item.notice !== 'unknown') resolveNotice(item.notice)
			if (id !== messageId) return undefined
			phase = 'running'
			if (item?.delivery !== 'queue') ambiguous = true
			return undefined
		}
		if (item === undefined || item.type === 'compaction' || item.type === 'move') return undefined
		if (item.notice !== undefined) {
			const owner = item.notice === 'unknown' ? undefined : resolveNotice(item.notice)
			if (phase === 'candidate')
				return owner === 'foreign'
					? independent()
					: unavailable('An unattributed background notice arrived after this turn’s response')
			if (owner === 'target') {
				step = undefined
				phase = 'running'
			} else ambiguous = true
			return undefined
		}
		if (item.type === 'synthetic' && item.delivery === 'steer') {
			if (phase === 'candidate') return independent()
			if (phase === 'waiting') ambiguous = true
			return undefined
		}
		if (item.type === 'user' && item.delivery === 'steer' && phase === 'running') {
			ambiguous = true
			return undefined
		}
		return independent()
	}

	const block = (reason: string) => {
		blocked ??= reason
	}

	/** Failed subagent calls keep their child's identity in progress metadata; the child may still run. */
	const toolSettled = (
		event: Extract<DurableEvent, { type: 'session.tool.success' | 'session.tool.failed' }>,
	) => {
		const { metadata } = event.data
		if (
			phase === 'running' &&
			toolNames.get(event.data.id) === 'subagent' &&
			typeof metadata?.sessionID === 'string'
		)
			children.add(metadata.sessionID)
	}

	/**
	 * Calling a running subagent again joins its job, whose one completion notice cannot be matched to both
	 * calls; a call after it finished starts another generation whose notice cannot be told apart.
	 */
	const launched = (event: Extract<DurableEvent, { type: 'session.tool.success' }>) => {
		const owner: Owner = phase === 'running' ? 'target' : 'foreign'
		const key = backgroundLaunch(toolNames.get(event.data.id), event.data.metadata)
		if (key === undefined) return
		if (key === 'unsupported') {
			if (owner === 'target')
				block('This turn launched background work whose completion cannot be attributed to it')
			return
		}
		if (outstanding.has(key)) {
			if (owner === 'target')
				block('This turn relaunched a background helper whose notices cannot be told apart')
			return
		}
		outstanding.set(key, [owner])
	}

	const execution = (event: DurableEvent): Verdict | undefined => {
		if (phase !== 'running' && phase !== 'waiting') return undefined
		switch (event.type) {
			case 'session.execution.succeeded':
				return succeeded()
			case 'session.execution.failed': {
				// While waiting, only other input starts a busy period, and a failure does not cancel this turn's jobs.
				if (phase === 'waiting') return undefined
				const { type, message } = event.data.error
				return { _tag: 'Failed', error: { type, message } }
			}
			case 'session.execution.interrupted':
				// A shutdown keeps the native recovery claim; the restarted server resumes this turn.
				if (event.data.reason === 'shutdown') {
					if (phase === 'running') recovering = true
					return undefined
				}
				return { _tag: 'Interrupted', reason: event.data.reason }
			default:
				return undefined
		}
	}

	const stepEvent = (event: DurableEvent) => {
		if (phase !== 'running') return
		switch (event.type) {
			case 'session.step.started':
				recovering = false
				step = { id: event.data.assistantMessageID, settled: 'open', continues: false }
				return
			case 'session.step.ended':
				if (step?.id !== event.data.assistantMessageID) return
				step.settled = 'ended'
				step.finish = event.data.finish
				return
			case 'session.tool.called':
			case 'session.tool.success':
			case 'session.tool.failed':
				// `executed` marks provider-executed tools; any other call makes native run another step.
				if (step?.id === event.data.assistantMessageID && !event.data.executed)
					step.continues = true
				return
			case 'session.step.failed':
				if (step?.id === event.data.assistantMessageID) step.settled = 'failed'
				return
		}
	}

	const visit = (event: DurableEvent): Verdict | undefined => {
		switch (event.type) {
			case 'session.inbox.enqueued': {
				const { item } = event.data
				if (event.data.inboxID === messageId) enqueued = true
				inbox.set(event.data.inboxID, {
					type: item.type,
					delivery: item.delivery,
					notice: item.type === 'synthetic' ? completionNotice(item.payload.metadata) : undefined,
				})
				return undefined
			}
			case 'session.inbox.delivery.changed': {
				const item = inbox.get(event.data.inboxID)
				if (item !== undefined) item.delivery = event.data.delivery
				return undefined
			}
			case 'session.inbox.cancelled':
				inbox.delete(event.data.inboxID)
				return phase === 'before' && event.data.inboxID === messageId
					? { _tag: 'InputCancelled' }
					: undefined
			case 'session.inbox.delivered': {
				const verdict = delivered(event.data.inboxID)
				inbox.delete(event.data.inboxID)
				return verdict
			}
			case 'session.step.started':
				toolNames.clear()
				stepEvent(event)
				return undefined
			case 'session.tool.input.started':
				toolNames.set(event.data.id, event.data.name)
				return undefined
			case 'session.tool.success':
				stepEvent(event)
				toolSettled(event)
				launched(event)
				return undefined
			case 'session.tool.failed':
				stepEvent(event)
				toolSettled(event)
				return undefined
			default:
				stepEvent(event)
				return execution(event)
		}
	}

	return {
		visit,
		children,
		end: (): End => {
			if (!enqueued) return unavailable('The native session history has no record of this input')
			if (phase === 'candidate' && candidate !== undefined)
				return { _tag: 'Candidate', completion: candidate }
			return pending
		},
	}
}

/** Joins every text part of the final response in content order; a response whose text parts are all empty has no message. */
const respond = Effect.fn('OpenCodeWorker.respond')(function* (
	client: OpenCodeClient,
	sessionID: Session.ID,
	assistantMessageId: string,
) {
	const message = yield* client.session.message
		.get({ sessionID, messageID: SessionMessage.ID.make(assistantMessageId) })
		.pipe(
			Effect.map(Option.some),
			Effect.catchTag('MessageNotFoundError', () => Effect.succeedNone),
			nativeRequest,
		)
	if (Option.isNone(message)) return unavailable('The final native response no longer exists')
	const assistant = message.value
	if (
		assistant.id !== assistantMessageId ||
		assistant.type !== 'assistant' ||
		assistant.error !== undefined ||
		assistant.time.completed === undefined ||
		assistant.finish === 'length' ||
		assistant.content.some((part) => part.type === 'tool' && part.executed !== true)
	) {
		return unavailable('The final native response is not a completed assistant message')
	}
	const parts = assistant.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
	if (parts.every((text) => text.length === 0))
		return { _tag: 'CompletedWithoutMessage' } satisfies NativeResult
	const text = parts.join('\n\n')
	return { _tag: 'Completed', message: { id: assistant.id, text } } satisfies NativeResult
})

/**
 * A child reports its first settled turn to its parent; background work it launched, or a nested subagent,
 * can continue the child after that report, so the parent's notice cannot prove the child finished.
 */
const childDetached = Effect.fn('OpenCodeWorker.childDetached')(function* (
	client: OpenCodeClient,
	childId: string,
) {
	const { found } = yield* replayLog(client, Session.ID.make(childId), (event) => {
		if (event.type === 'session.tool.input.started' && event.data.name === 'subagent') return true
		if (event.type === 'session.tool.success' && launchesBackground(event.data.metadata))
			return true
		return undefined
	}).pipe(
		Effect.catchIf(
			(error) => error.code === 'ownership',
			() => Effect.succeed({ found: Option.some(true) }),
		),
	)
	return Option.isSome(found)
})

const complete = Effect.fn('OpenCodeWorker.complete')(function* (
	client: OpenCodeClient,
	sessionID: Session.ID,
	completion: Completion,
	children: ReadonlySet<string>,
) {
	for (const child of children) {
		if (yield* childDetached(client, child))
			return unavailable(
				'A subagent of this turn has detached work or nested subagents that its completion cannot prove settled',
			)
	}
	return yield* respond(client, sessionID, completion.assistantMessageId)
})

/** Background jobs stay listed, whatever their status, until their completion notice is admitted. */
const quiescent = Effect.fn('OpenCodeWorker.quiescent')(function* (
	client: OpenCodeClient,
	sessionID: Session.ID,
) {
	const inbox = yield* client.session.inbox.list({ sessionID }).pipe(nativeRequest)
	const active = yield* client.session.active().pipe(nativeRequest)
	const jobs = yield* client.experimental.job
		.list({ sessionID, descendants: true })
		.pipe(nativeRequest)
	return inbox.length === 0 && active[sessionID] === undefined && jobs.length === 0
})

const confirmAttempts = 5

export const readResult = Effect.fn('OpenCodeWorker.readResult')(function* (
	client: OpenCodeClient,
	sessionID: Session.ID,
	messageId: string,
): Effect.fn.Return<NativeResult, WorkerError> {
	const fold = foldResult(messageId)
	let replay = yield* replayLog(client, sessionID, fold.visit)
	for (let attempt = 0; attempt < confirmAttempts; attempt++) {
		if (Option.isSome(replay.found)) {
			const verdict = replay.found.value
			if (verdict._tag !== 'Respond') return verdict
			return yield* complete(client, sessionID, verdict, fold.children)
		}
		const end = fold.end()
		if (end._tag !== 'Candidate') return end
		// Live reads race new history, so a candidate is confirmed only if the log did not move across them.
		const quiet = yield* quiescent(client, sessionID)
		const watermark: LogSeq | undefined = replay.seq
		replay = yield* replayLog(client, sessionID, fold.visit, watermark)
		if (Option.isNone(replay.found) && replay.seq === watermark) {
			if (!quiet) return pending
			return yield* complete(client, sessionID, end.completion, fold.children)
		}
	}
	return pending
})
