import { open } from 'node:fs/promises'
import path from 'node:path'
import { Deferred, Effect, Option, Schema, Semaphore } from 'effect'
import { describeUnknown, schemaErrorMessage } from '../../lib/guards'
import {
	MAX_SLACK_MARKDOWN_CHARS,
	MAX_SLACK_OUTBOUND_BYTES_PER_TURN,
	MAX_SLACK_OUTBOUND_BYTES_PROCESS,
	MAX_SLACK_OUTBOUND_FILE_BYTES,
	MAX_SLACK_OUTBOUND_FILES_PER_TURN,
	SLACK_SERVICE_ACTIVATION_ENV,
	type SlackConfig,
} from './config'
import { type SlackIntegrationError, slackIntegrationError } from './errors'
import {
	chunkSlackMarkdown,
	compareSlackMessages,
	fetchSlackThread,
	isAfterSlackTimestamp,
	prepareSlackMessageParts,
	resolveSlackFiles,
	selectSlackAttachmentIDs,
} from './history'
import {
	DEFAULT_SLACK_RUNNER_OPTIONS,
	makeSlackRuntimeState,
	type SlackActiveTurn,
	type SlackMentionDispatcher,
	type SlackPendingTurn,
	type SlackPluginContext,
	type SlackRunnerConfig,
	type SlackRunnerOptions,
	type SlackRuntimeState,
} from './runtime'
import {
	type SlackAppMentionInput,
	SlackAppMentionInput as SlackAppMentionInputSchema,
	type SlackAssistantResult,
	SlackAttachFileResult,
	type SlackAttachFileResult as SlackAttachFileResultType,
	SlackMessage,
	SlackOpenCodeEvent,
	SlackOpenCodeEventEnvelope,
	type SlackPromptPart,
	SlackStatusResult,
	type SlackStatusResult as SlackStatusResultType,
} from './schema'
import { uploadSlackFiles } from './upload'

const MAX_SEEN_SLACK_EVENTS = 1_000
const SLACK_TURN_ERROR_MESSAGE =
	'OpenCode reported an error while processing this turn. Check the Limitless service logs.'
const SLACK_THINKING_HEADER = '🧠 *Thinking…*'
const OPEN_CODE_ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
let lastOpenCodeMessageTimestamp = 0
let openCodeMessageCounter = 0

function openCodeMessageID(after: string | undefined): string {
	const timestamp = Date.now()
	if (timestamp === lastOpenCodeMessageTimestamp) openCodeMessageCounter += 1
	else {
		lastOpenCodeMessageTimestamp = timestamp
		openCodeMessageCounter = 1
	}
	const candidate = BigInt(timestamp) * 0x1000n + BigInt(openCodeMessageCounter)
	const previousHex = after?.match(/^msg_([0-9a-f]{12})/u)?.[1]
	const value =
		previousHex === undefined
			? candidate
			: candidate > BigInt(`0x${previousHex}`)
				? candidate
				: BigInt(`0x${previousHex}`) + 1n
	const time = Array.from({ length: 6 }, (_, index) =>
		Number((value >> BigInt(40 - 8 * index)) & 0xffn)
			.toString(16)
			.padStart(2, '0'),
	).join('')
	const bytes = crypto.getRandomValues(new Uint8Array(14))
	const random = Array.from(
		bytes,
		(byte) => OPEN_CODE_ID_CHARS[byte % OPEN_CODE_ID_CHARS.length],
	).join('')
	return `msg_${time}${random}`
}

function integrationFailure(operation: string, error: unknown): SlackIntegrationError {
	return slackIntegrationError(
		operation,
		`${operation} failed: ${describeUnknown(error).slice(0, 500)}`,
	)
}

function configuredToken(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
	kind: string,
) {
	const token = env[name]?.trim()
	if (token === undefined || token.length === 0)
		return Effect.fail(
			slackIntegrationError('Slack startup', `${kind} environment variable is unset`),
		)
	if (/\r|\n/u.test(token))
		return Effect.fail(slackIntegrationError('Slack startup', `${kind} contains a line break`))
	return Effect.succeed(token)
}

function rememberSlackEvent(state: SlackRuntimeState, eventID: string): boolean {
	if (state.seenEventIDs.has(eventID)) return false
	state.seenEventIDs.add(eventID)
	state.seenEventOrder.push(eventID)
	while (state.seenEventOrder.length > MAX_SEEN_SLACK_EVENTS) {
		const expired = state.seenEventOrder.shift()
		if (expired !== undefined) state.seenEventIDs.delete(expired)
	}
	return true
}

function semaphoreForThread(state: SlackRuntimeState, threadKey: string): Semaphore.Semaphore {
	const existing = state.threadSemaphores.get(threadKey)
	if (existing !== undefined) return existing
	const created = Semaphore.makeUnsafe(1)
	state.threadSemaphores.set(threadKey, created)
	return created
}

export function slackThreadKey(team: string, channel: string, threadTs: string): string {
	return `${team}:${channel}:${threadTs}`
}

export function stripSlackBotMention(text: string, botUserID: string): string {
	return text.replaceAll(`<@${botUserID}>`, ' ').replace(/\s+/gu, ' ').trim()
}

export function isSlackCancelCommand(text: string, botUserID: string): boolean {
	return /^(?:cancel|stop)$/iu.test(stripSlackBotMention(text, botUserID))
}

function activeRootForSession(state: SlackRuntimeState, sessionID: string): string | undefined {
	if (state.activeTurns.has(sessionID)) return sessionID
	const root = state.childToRoot.get(sessionID)
	return root !== undefined && state.activeTurns.has(root) ? root : undefined
}

function duringPending<A, E, R>(
	pending: SlackPendingTurn,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, E, R> {
	return Effect.raceFirst(
		effect.pipe(Effect.map(Option.some)),
		Deferred.await(pending.cancelRequested).pipe(Effect.as(Option.none<A>())),
	)
}

function openCodeParts(parts: ReadonlyArray<SlackPromptPart>) {
	return parts.map((part) =>
		part.type === 'text'
			? { type: 'text' as const, text: part.text }
			: {
					type: 'file' as const,
					mime: part.mime,
					filename: part.filename,
					url: part.url,
				},
	)
}

function cleanupTurn(state: SlackRuntimeState, turn: SlackActiveTurn): void {
	state.queuedOutboundBytes -= turn.queuedFileBytes
	turn.queuedFiles.clear()
	turn.queuedFileBytes = 0
	if (state.activeTurns.get(turn.rootSessionID) === turn)
		state.activeTurns.delete(turn.rootSessionID)
	for (const [child, root] of state.childToRoot) {
		if (root === turn.rootSessionID) state.childToRoot.delete(child)
	}
}

function slackApp(state: SlackRuntimeState) {
	return state.app === null
		? Effect.fail(slackIntegrationError('Slack operation', 'Slack is not active in this process'))
		: Effect.succeed(state.app)
}

const postSlackMessage = Effect.fn('postSlackMessage')(function* (
	state: SlackRuntimeState,
	channel: string,
	threadTs: string,
	text: string,
	markdown = false,
) {
	const app = yield* slackApp(state)
	const response = yield* Effect.tryPromise({
		try: () =>
			app.client.chat.postMessage(
				markdown
					? { channel, thread_ts: threadTs, markdown_text: text }
					: { channel, thread_ts: threadTs, text },
			),
		catch: (error) => integrationFailure('Slack message post', error),
	})
	if (response.ts === undefined)
		return yield* slackIntegrationError(
			'Slack message post',
			'Slack did not return a message timestamp',
		)
	return response.ts
})

const updateSlackMessage = Effect.fn('updateSlackMessage')(function* (
	state: SlackRuntimeState,
	channel: string,
	ts: string,
	text: string,
	markdown: boolean,
) {
	const app = yield* slackApp(state)
	yield* Effect.tryPromise({
		try: () =>
			app.client.chat.update(
				markdown ? { channel, ts, markdown_text: text } : { channel, ts, text },
			),
		catch: (error) => integrationFailure('Slack message update', error),
	})
})

const createOpenCodeSession = Effect.fn('createOpenCodeSession')(function* (
	context: SlackPluginContext,
	channel: string,
	threadTs: string,
	signal: AbortSignal,
) {
	const response = yield* Effect.tryPromise({
		try: () =>
			context.client.session.create({
				body: { title: `Slack ${channel} thread ${threadTs}` },
				signal,
				throwOnError: true,
			}),
		catch: (error) => integrationFailure('OpenCode session creation', error),
	})
	return response.data.id
})

const startOpenCodeTurn = Effect.fn('startOpenCodeTurn')(function* (
	config: SlackConfig,
	context: SlackPluginContext,
	sessionID: string,
	messageID: string,
	parts: ReadonlyArray<SlackPromptPart>,
	signal?: AbortSignal,
) {
	yield* Effect.tryPromise({
		try: () =>
			context.client.session.promptAsync({
				path: { id: sessionID },
				body: {
					messageID,
					agent: config.agent,
					tools: { question: false, slack_attach_file: true, slack_status: true },
					parts: openCodeParts(parts),
				},
				...(signal === undefined ? {} : { signal }),
				throwOnError: true,
			}),
		catch: (error) => integrationFailure('OpenCode turn start', error),
	})
})

const startTrackedOpenCodeTurn = Effect.fn('startTrackedOpenCodeTurn')(function* (
	turn: SlackActiveTurn,
	config: SlackConfig,
	context: SlackPluginContext,
	messageID: string,
	parts: ReadonlyArray<SlackPromptPart>,
) {
	turn.inFlightAdmissions += 1
	yield* startOpenCodeTurn(config, context, turn.rootSessionID, messageID, parts).pipe(
		Effect.ensuring(
			Effect.sync(() => {
				turn.inFlightAdmissions -= 1
			}),
		),
	)
})

const abortOpenCodeTurn = Effect.fn('abortOpenCodeTurn')(function* (
	context: SlackPluginContext,
	sessionID: string,
) {
	const response = yield* Effect.tryPromise({
		try: () => context.client.session.abort({ path: { id: sessionID }, throwOnError: true }),
		catch: (error) => integrationFailure('OpenCode turn cancellation', error),
	})
	return response.data
})

const rejectOpenCodePermission = Effect.fn('rejectOpenCodePermission')(function* (
	context: SlackPluginContext,
	sessionID: string,
	permissionID: string,
) {
	yield* Effect.tryPromise({
		try: () =>
			context.client.postSessionIdPermissionsPermissionId({
				path: { id: sessionID, permissionID },
				body: { response: 'reject' },
				throwOnError: true,
			}),
		catch: (error) => integrationFailure('OpenCode permission rejection', error),
	})
})

const completedAssistantResults = Effect.fn('completedAssistantResults')(function* (
	context: SlackPluginContext,
	turn: SlackActiveTurn,
) {
	if (turn.messageID === null) return [] as ReadonlyArray<SlackAssistantResult>
	const response = yield* Effect.tryPromise({
		try: () =>
			context.client.session.messages({
				path: { id: turn.rootSessionID },
				throwOnError: true,
			}),
		catch: (error) => integrationFailure('OpenCode response retrieval', error),
	})
	const results: Array<SlackAssistantResult> = []
	for (const message of response.data) {
		if (message.info.role !== 'assistant') continue
		if (message.info.id <= turn.messageID) continue
		if (message.info.summary === true || message.info.time.completed === undefined) continue
		if (
			message.info.error === undefined &&
			(message.info.finish === undefined ||
				message.info.finish === 'tool-calls' ||
				message.info.finish === 'unknown')
		)
			continue
		const textParts: Array<string> = []
		for (const part of message.parts)
			if (part.type === 'text' && part.ignored !== true) textParts.push(part.text)
		const text = textParts.join('\n').trim()
		results.push({
			id: message.info.id,
			failed: message.info.error !== undefined,
			parentID: message.info.parentID ?? null,
			text,
		})
	}
	return results.sort((left, right) => left.id.localeCompare(right.id))
})

function quotedTraceStatus(status: string): string {
	return status
		.split('\n')
		.map((line) => `> ${line}`)
		.join('\n')
}

const publishTerminalText = Effect.fn('publishTerminalText')(function* (
	state: SlackRuntimeState,
	turn: SlackActiveTurn,
	text: string,
) {
	for (const chunk of chunkSlackMarkdown(text))
		yield* postSlackMessage(state, turn.channel, turn.threadTs, chunk, true)
})

const publishQueuedFiles = Effect.fn('publishQueuedFiles')(function* (
	state: SlackRuntimeState,
	turn: SlackActiveTurn,
	options: SlackRunnerOptions,
) {
	if (turn.queuedFiles.size === 0) return
	const uploadClient = state.uploadClient
	if (uploadClient === null)
		return yield* slackIntegrationError('Slack file upload', 'Slack is not active in this process')
	const files = [...turn.queuedFiles.values()]
	const reservedBytes = turn.queuedFileBytes
	turn.queuedFiles.clear()
	turn.queuedFileBytes = 0
	yield* state.outboundUploadSemaphore
		.withPermits(1)(uploadSlackFiles(uploadClient, options, turn.channel, turn.threadTs, files))
		.pipe(
			Effect.catch((error) =>
				Effect.logError(`[limitless] ${error.operation}: ${error.message}`).pipe(
					Effect.andThen(
						publishTerminalText(
							state,
							turn,
							`⚠️ I could not attach ${files.map((file) => `\`${file.filename}\``).join(', ')}. Check the Limitless service logs.`,
						),
					),
				),
			),
			Effect.ensuring(
				Effect.sync(() => {
					state.queuedOutboundBytes -= reservedBytes
				}),
			),
		)
})

const drainAssistantResults = Effect.fn('drainAssistantResults')(function* (
	context: SlackPluginContext,
	state: SlackRuntimeState,
	turn: SlackActiveTurn,
) {
	const results = yield* completedAssistantResults(context, turn)
	for (const result of results) {
		if (state.activeTurns.get(turn.rootSessionID) !== turn || turn.cancelled || turn.finishing)
			return results
		if (turn.deliveredAssistantIDs.has(result.id)) continue
		const text = result.failed || result.text.length === 0 ? SLACK_TURN_ERROR_MESSAGE : result.text
		const chunks = chunkSlackMarkdown(text)
		let index = turn.assistantChunkProgress.get(result.id) ?? 0
		while (index < chunks.length) {
			if (state.activeTurns.get(turn.rootSessionID) !== turn || turn.cancelled || turn.finishing)
				return results
			const chunk = chunks[index]
			if (chunk === undefined) break
			yield* postSlackMessage(state, turn.channel, turn.threadTs, chunk, true)
			index += 1
			turn.assistantChunkProgress.set(result.id, index)
		}
		turn.assistantChunkProgress.delete(result.id)
		turn.deliveredAssistantIDs.add(result.id)
	}
	return results
})

const finishTurn = Effect.fn('finishTurn')(function* (
	state: SlackRuntimeState,
	turn: SlackActiveTurn,
	effect: Effect.Effect<void, SlackIntegrationError>,
) {
	yield* effect.pipe(
		Effect.catch((error) =>
			Effect.logError(
				`[limitless] ${error.operation} while completing Slack turn: ${error.message}`,
			),
		),
		Effect.ensuring(
			Effect.sync(() => cleanupTurn(state, turn)).pipe(
				Effect.andThen(Deferred.succeed(turn.done, undefined)),
				Effect.asVoid,
			),
		),
	)
})

const failTurn = Effect.fn('failTurn')(function* (
	state: SlackRuntimeState,
	turn: SlackActiveTurn,
	error: SlackIntegrationError,
) {
	yield* Effect.logError(`[limitless] ${error.operation}: ${error.message}`)
	if (turn.cancelled || turn.finishing) {
		yield* Deferred.await(turn.done)
		return
	}
	turn.finishing = true
	yield* turn.statusSemaphore.withPermits(1)(
		publishTerminalText(
			state,
			turn,
			'OpenCode could not complete this turn. Check the Limitless service logs.',
		).pipe(
			Effect.catch((updateError) =>
				Effect.logError(`[limitless] failed to report Slack turn failure: ${updateError.message}`),
			),
		),
	)
	cleanupTurn(state, turn)
	yield* Deferred.succeed(turn.done, undefined)
})

const settleCancelledTurn = Effect.fn('settleCancelledTurn')(function* (
	state: SlackRuntimeState,
	turn: SlackActiveTurn,
) {
	turn.finishing = true
	cleanupTurn(state, turn)
	yield* Deferred.succeed(turn.done, undefined)
})

const abortStartedTurn = Effect.fn('abortStartedTurn')(function* (
	runner: SlackRunnerConfig,
	turn: SlackActiveTurn,
) {
	if (turn.launchState === 'not-started' || turn.abortSent) return false
	turn.abortSent = true
	const aborted = yield* abortOpenCodeTurn(runner.plugin, turn.rootSessionID).pipe(
		Effect.catch((error) =>
			Effect.logError(`[limitless] Slack cancellation failed: ${error.message}`).pipe(
				Effect.as(false),
			),
		),
	)
	if (!aborted) turn.abortSent = false
	return aborted
})

function mentionAsMessage(input: SlackAppMentionInput): SlackMessage {
	return SlackMessage.make({
		ts: input.event.ts,
		thread_ts: input.event.thread_ts,
		text: input.event.text,
		user: input.event.user,
		files: input.event.files,
	})
}

const processSlackMention = Effect.fn('processSlackMention')(function* (
	runner: SlackRunnerConfig,
	input: SlackAppMentionInput,
	threadKey: string,
	threadTs: string,
	pending: SlackPendingTurn,
) {
	const { config, options, plugin, state } = runner
	if (pending.cancelled) return null
	let thread = state.threads.get(threadKey)
	const existingSession = thread !== undefined
	let turn = thread === undefined ? undefined : state.activeTurns.get(thread.sessionID)
	if (turn?.cancelled || turn?.finishing) return turn.done
	const existingTurn = turn
	const statusTs =
		existingTurn === undefined
			? yield* postSlackMessage(state, input.event.channel, threadTs, SLACK_THINKING_HEADER, true)
			: yield* existingTurn.statusSemaphore.withPermits(1)(
					Effect.gen(function* () {
						const ts = yield* postSlackMessage(
							state,
							input.event.channel,
							threadTs,
							SLACK_THINKING_HEADER,
							true,
						)
						existingTurn.statusTs = ts
						existingTurn.traceText = SLACK_THINKING_HEADER
						return ts
					}),
				)
	if (pending.cancelled) return null
	if (thread === undefined) {
		const sessionID = yield* createOpenCodeSession(
			plugin,
			input.event.channel,
			threadTs,
			pending.abort.signal,
		).pipe(
			Effect.catch((error) =>
				pending.cancelled
					? Effect.void
					: postSlackMessage(
							state,
							input.event.channel,
							threadTs,
							'OpenCode could not create a session for this thread. Check the Limitless service logs.',
							true,
						).pipe(
							Effect.catch(() => Effect.void),
							Effect.andThen(Effect.logError(`[limitless] ${error.operation}: ${error.message}`)),
							Effect.as(undefined),
						),
			),
		)
		if (sessionID === undefined) return null
		thread = { sessionID, lastImportedTs: undefined, lastMessageID: undefined }
		state.threads.set(threadKey, thread)
	}
	const isNewTurn = turn === undefined
	if (turn === undefined) {
		const done = yield* Deferred.make<void>()
		turn = {
			rootSessionID: thread.sessionID,
			threadKey,
			channel: input.event.channel,
			threadTs,
			statusTs,
			traceText: SLACK_THINKING_HEADER,
			done,
			statusSemaphore: Semaphore.makeUnsafe(1),
			messageID: null,
			latestMessageID: null,
			launchState: 'not-started',
			busyObserved: false,
			waitingForBusy: false,
			abortSent: false,
			steered: false,
			generation: 0,
			busyVersion: 0,
			inFlightAdmissions: 0,
			deliveredAssistantIDs: new Set(),
			assistantChunkProgress: new Map(),
			queuedFiles: new Map(),
			queuedFileBytes: 0,
			cancelled: pending.cancelled,
			finishing: false,
		}
		state.activeTurns.set(thread.sessionID, turn)
	}
	if (turn.cancelled) {
		yield* settleCancelledTurn(state, turn)
		return null
	}
	const execute = Effect.gen(function* () {
		if (pending.cancelled || turn.cancelled) return
		const cancelledThroughTs = state.cancelledThroughTs.get(threadKey)
		const oldest =
			cancelledThroughTs === undefined ||
			isAfterSlackTimestamp(thread.lastImportedTs ?? '', cancelledThroughTs)
				? thread.lastImportedTs
				: cancelledThroughTs
		const fetchedResult = yield* duringPending(
			pending,
			fetchSlackThread(
				state.app as NonNullable<SlackRuntimeState['app']>,
				input.event.channel,
				threadTs,
				input.event.ts,
				oldest,
			),
		)
		if (Option.isNone(fetchedResult)) return
		const fetched = fetchedResult.value
		const byTimestamp = new Map(fetched.map((message) => [message.ts, message]))
		if (!byTimestamp.has(input.event.ts)) byTimestamp.set(input.event.ts, mentionAsMessage(input))
		const unresolvedMessages = [...byTimestamp.values()]
			.filter(
				(message) =>
					isAfterSlackTimestamp(message.ts, oldest) &&
					!isAfterSlackTimestamp(message.ts, input.event.ts) &&
					message.ts !== statusTs,
			)
			.sort(compareSlackMessages)
		const resolvedMessages = yield* duringPending(
			pending,
			resolveSlackFiles(
				unresolvedMessages,
				input.event.ts,
				state.app as NonNullable<SlackRuntimeState['app']>,
			),
		)
		if (Option.isNone(resolvedMessages)) return
		const messages = resolvedMessages.value
		const selectedAttachments = selectSlackAttachmentIDs(messages, input.event.ts)
		const consumedAttachments = new Set<string>()
		const consumedTextBytes = new Map<string, number>()
		const botUserID = state.botUserID as string
		const botToken = state.botToken as string
		let triggerAvailable = false
		const promptParts: Array<SlackPromptPart> = []
		for (const message of messages) {
			if (pending.cancelled || turn.cancelled) return
			if (existingSession && message.user === botUserID && message.ts !== input.event.ts) {
				continue
			}
			const isTrigger = message.ts === input.event.ts
			const override = isTrigger ? stripSlackBotMention(input.event.text, botUserID) : undefined
			const prepared = yield* duringPending(
				pending,
				prepareSlackMessageParts(
					message,
					selectedAttachments,
					consumedAttachments,
					consumedTextBytes,
					state.app as NonNullable<SlackRuntimeState['app']>,
					botUserID,
					botToken,
					options,
					pending.abort.signal,
					override,
				),
			)
			if (Option.isNone(prepared)) return
			const parts = prepared.value
			promptParts.push(...parts)
			if (isTrigger) triggerAvailable = true
		}
		if (!triggerAvailable)
			return yield* slackIntegrationError(
				'Slack turn preparation',
				'The triggering Slack message was not available',
			)
		if (pending.cancelled || turn.cancelled) return
		const messageID = openCodeMessageID(thread.lastMessageID)
		thread.lastMessageID = messageID
		if (isNewTurn) {
			turn.messageID = messageID
			turn.launchState = 'starting'
		}
		yield* startTrackedOpenCodeTurn(turn, config, plugin, messageID, promptParts)
		turn.latestMessageID = messageID
		turn.generation += 1
		if (!isNewTurn) turn.steered = true
		thread.lastImportedTs = input.event.ts
		if (isNewTurn) turn.launchState = 'started'
		if (pending.cancelled || turn.cancelled) {
			turn.abortSent = false
			yield* abortStartedTurn(runner, turn)
		}
	})
	if (isNewTurn)
		yield* execute.pipe(
			Effect.catch((error) =>
				turn.cancelled
					? Effect.sync(() => {
							turn.abortSent = false
						}).pipe(Effect.andThen(abortStartedTurn(runner, turn)), Effect.asVoid)
					: failTurn(state, turn, error),
			),
		)
	else
		yield* execute.pipe(
			Effect.catch((error) =>
				turn.cancelled
					? Effect.sync(() => {
							turn.abortSent = false
						}).pipe(Effect.andThen(abortStartedTurn(runner, turn)), Effect.asVoid)
					: Effect.logError(`[limitless] ${error.operation}: ${error.message}`).pipe(
							Effect.andThen(
								publishTerminalText(
									state,
									turn,
									'Gary could not read the latest Slack messages. Mention Gary again to retry.',
								).pipe(Effect.catch(() => Effect.void)),
							),
						),
			),
		)
	return null
})

const cancelSlackTurn = Effect.fn('cancelSlackTurn')(function* (
	runner: SlackRunnerConfig,
	input: SlackAppMentionInput,
	threadKey: string,
	threadTs: string,
) {
	const thread = runner.state.threads.get(threadKey)
	const turn = thread === undefined ? undefined : runner.state.activeTurns.get(thread.sessionID)
	const pending = runner.state.pendingTurns.get(threadKey)
	for (const item of pending ?? []) {
		item.cancelled = true
		item.abort.abort()
		yield* Deferred.succeed(item.cancelRequested, undefined)
	}
	const cancelledThroughTs = runner.state.cancelledThroughTs.get(threadKey)
	if (cancelledThroughTs === undefined || isAfterSlackTimestamp(input.event.ts, cancelledThroughTs))
		runner.state.cancelledThroughTs.set(threadKey, input.event.ts)
	if (turn === undefined && (pending === undefined || pending.size === 0)) {
		yield* postSlackMessage(
			runner.state,
			input.event.channel,
			threadTs,
			'Nothing is currently running in this thread.',
			true,
		)
		return
	}
	if (turn !== undefined) {
		turn.cancelled = true
		turn.finishing = true
		if (turn.launchState === 'not-started') yield* settleCancelledTurn(runner.state, turn)
		else yield* abortStartedTurn(runner, turn)
	}
	const reportCancellation = postSlackMessage(
		runner.state,
		input.event.channel,
		threadTs,
		`Cancelled by <@${input.event.user}>.`,
		true,
	).pipe(
		Effect.catch((error) =>
			Effect.logError(`[limitless] failed to report Slack cancellation: ${error.message}`),
		),
	)
	if (turn === undefined) yield* reportCancellation
	else yield* turn.statusSemaphore.withPermits(1)(reportCancellation)
})

export type SlackRunner = {
	readonly enabled: boolean
	readonly start: (dispatch: SlackMentionDispatcher) => Effect.Effect<void, SlackIntegrationError>
	readonly stop: Effect.Effect<void>
	readonly handleMention: (input: unknown) => Effect.Effect<void>
	readonly handleOpenCodeEvent: (event: unknown) => Effect.Effect<void>
	readonly updateStatus: (
		sessionID: string,
		text: string,
	) => Effect.Effect<SlackStatusResultType, SlackIntegrationError>
	readonly attachFile: (
		sessionID: string,
		filePath: string,
		directory: string,
	) => Effect.Effect<SlackAttachFileResultType, SlackIntegrationError>
	readonly shouldDenyPermission: (sessionID: string) => Effect.Effect<boolean>
}

export const createSlackRunner = Effect.fn('createSlackRunner')(function* (
	config: SlackConfig,
	plugin: SlackPluginContext,
	providedOptions: Partial<SlackRunnerOptions> = {},
) {
	const options = { ...DEFAULT_SLACK_RUNNER_OPTIONS, ...providedOptions }
	const state: SlackRuntimeState = yield* makeSlackRuntimeState
	const runner = { config, plugin, options, state } satisfies SlackRunnerConfig

	const start = Effect.fn('SlackRunner.start')(function* (dispatch: SlackMentionDispatcher) {
		if (!config.enabled || options.env[SLACK_SERVICE_ACTIVATION_ENV] !== '1') return
		if (config.repository === null)
			return yield* slackIntegrationError('Slack startup', 'Slack repository is not configured')
		const [configuredDirectory, instanceDirectory] = yield* Effect.all([
			Effect.tryPromise({
				try: () => options.resolveDirectory(config.repository as string),
				catch: (error) => integrationFailure('Slack repository resolution', error),
			}),
			Effect.tryPromise({
				try: () => options.resolveDirectory(plugin.directory),
				catch: (error) => integrationFailure('OpenCode directory resolution', error),
			}),
		])
		if (configuredDirectory !== instanceDirectory) return
		if (options.readyFile === null)
			return yield* slackIntegrationError(
				'Slack startup',
				'XDG_RUNTIME_DIR is required for Slack readiness supervision',
			)
		state.readyFileOwned = true
		yield* Effect.tryPromise({
			try: () => options.clearReady(options.readyFile as string),
			catch: (error) => integrationFailure('Slack readiness reset', error),
		})
		const botToken = yield* configuredToken(options.env, config.botTokenEnv, 'Slack bot token')
		const appToken = yield* configuredToken(options.env, config.appTokenEnv, 'Slack app token')
		const app = yield* Effect.try({
			try: () => options.makeApp(botToken, appToken, dispatch),
			catch: (error) => integrationFailure('Slack application creation', error),
		})
		const initialize = Effect.gen(function* () {
			const auth = yield* Effect.tryPromise({
				try: () => app.client.auth.test(),
				catch: (error) => integrationFailure('Slack authentication', error),
			})
			if (auth.user_id === undefined || auth.team_id === undefined)
				return yield* slackIntegrationError(
					'Slack authentication',
					'Slack authentication did not return bot user and workspace IDs',
				)
			state.app = app
			state.uploadClient = options.makeUploadClient(botToken)
			state.botToken = botToken
			state.botUserID = auth.user_id
			state.teamID = auth.team_id
			yield* Effect.tryPromise({
				try: app.start,
				catch: (error) => integrationFailure('Slack Socket Mode startup', error),
			})
			yield* Effect.tryPromise({
				try: () => options.markReady(options.readyFile as string, configuredDirectory),
				catch: (error) => integrationFailure('Slack readiness publication', error),
			})
			yield* Effect.logInfo(`[limitless] Slack Socket Mode connected for ${configuredDirectory}`)
		})
		yield* initialize.pipe(
			Effect.catch((error) =>
				Effect.sync(() => {
					state.app = null
					state.uploadClient = null
					state.botToken = null
					state.botUserID = null
					state.teamID = null
				}).pipe(
					Effect.andThen(
						Effect.tryPromise({
							try: app.stop,
							catch: () => undefined,
						}),
					),
					Effect.ignore,
					Effect.andThen(
						Effect.tryPromise({
							try: () => options.clearReady(options.readyFile as string),
							catch: () => undefined,
						}).pipe(Effect.ignore),
					),
					Effect.andThen(Effect.fail(error)),
				),
			),
		)
	})

	const stop = Effect.gen(function* () {
		for (const pending of state.pendingTurns.values())
			for (const item of pending) {
				item.cancelled = true
				item.abort.abort()
				yield* Deferred.succeed(item.cancelRequested, undefined)
			}
		state.pendingTurns.clear()
		for (const turn of state.activeTurns.values()) {
			turn.cancelled = true
			yield* Deferred.succeed(turn.done, undefined)
		}
		state.activeTurns.clear()
		state.childToRoot.clear()
		state.cancelledThroughTs.clear()
		const app = state.app
		state.app = null
		state.uploadClient = null
		state.botToken = null
		state.botUserID = null
		state.teamID = null
		if (app !== null)
			yield* Effect.tryPromise({ try: app.stop, catch: () => undefined }).pipe(Effect.ignore)
		if (state.readyFileOwned && options.readyFile !== null) {
			state.readyFileOwned = false
			yield* Effect.tryPromise({
				try: () => options.clearReady(options.readyFile as string),
				catch: () => undefined,
			}).pipe(Effect.ignore)
		}
	})

	const handleMention = Effect.fn('SlackRunner.handleMention')(function* (input: unknown) {
		if (state.app === null || state.botUserID === null || state.botToken === null) return
		const decoded = yield* Schema.decodeUnknownEffect(SlackAppMentionInputSchema)(input).pipe(
			Effect.catch((error) =>
				Effect.logWarning(
					`[limitless] ignored malformed Slack app_mention event: ${schemaErrorMessage(error)}`,
				).pipe(Effect.as(undefined)),
			),
		)
		if (decoded === undefined || decoded.body.team_id !== state.teamID) return
		if (!rememberSlackEvent(state, decoded.body.event_id)) return
		const threadTs = decoded.event.thread_ts ?? decoded.event.ts
		const threadKey = slackThreadKey(decoded.body.team_id, decoded.event.channel, threadTs)
		if (isSlackCancelCommand(decoded.event.text, state.botUserID)) {
			yield* cancelSlackTurn(runner, decoded, threadKey, threadTs).pipe(
				Effect.catch((error) =>
					Effect.logError(`[limitless] Slack cancellation handler failed: ${error.message}`),
				),
			)
			return
		}
		const cancelRequested = yield* Deferred.make<void>()
		const pending: SlackPendingTurn = {
			cancelled: false,
			abort: new AbortController(),
			cancelRequested,
		}
		const pendingForThread = state.pendingTurns.get(threadKey) ?? new Set<SlackPendingTurn>()
		pendingForThread.add(pending)
		state.pendingTurns.set(threadKey, pendingForThread)
		const admit = Effect.gen(function* () {
			while (!pending.cancelled) {
				const waitFor = yield* semaphoreForThread(state, threadKey).withPermits(1)(
					processSlackMention(runner, decoded, threadKey, threadTs, pending),
				)
				if (waitFor === null || pending.cancelled) return
				yield* Deferred.await(waitFor)
			}
		})
		yield* admit.pipe(
			Effect.ensuring(
				Effect.sync(() => {
					pendingForThread.delete(pending)
					if (pendingForThread.size === 0) state.pendingTurns.delete(threadKey)
				}),
			),
			Effect.catch((error) =>
				Effect.logError(`[limitless] Slack mention handler failed: ${error.message}`),
			),
		)
	})

	const handleOpenCodeEvent = Effect.fn('SlackRunner.handleOpenCodeEvent')(function* (
		event: unknown,
	) {
		if (state.app === null) return
		const envelope = Schema.decodeUnknownOption(SlackOpenCodeEventEnvelope)(event)
		if (
			Option.isNone(envelope) ||
			![
				'session.created',
				'session.updated',
				'session.deleted',
				'session.idle',
				'session.status',
				'session.error',
				'permission.asked',
				'message.updated',
			].includes(envelope.value.type)
		)
			return
		const decoded = yield* Schema.decodeUnknownEffect(SlackOpenCodeEvent)(event).pipe(
			Effect.catch((error) =>
				Effect.logWarning(
					`[limitless] ignored malformed ${envelope.value.type} Slack bridge event: ${schemaErrorMessage(error)}`,
				).pipe(Effect.as(undefined)),
			),
		)
		if (decoded === undefined) return
		switch (decoded.type) {
			case 'message.updated': {
				if (
					decoded.properties.info.role !== 'assistant' ||
					decoded.properties.info.summary === true ||
					decoded.properties.info.time.completed === undefined
				)
					return
				const turn = state.activeTurns.get(decoded.properties.info.sessionID)
				if (turn === undefined || turn.cancelled || turn.finishing) return
				yield* semaphoreForThread(state, turn.threadKey)
					.withPermits(1)(
						Effect.gen(function* () {
							if (
								state.activeTurns.get(turn.rootSessionID) !== turn ||
								turn.cancelled ||
								turn.finishing
							)
								return
							yield* drainAssistantResults(plugin, state, turn)
						}),
					)
					.pipe(
						Effect.catch((error) =>
							Effect.logError(
								`[limitless] failed to deliver completed Slack response: ${error.message}`,
							),
						),
					)
				return
			}
			case 'session.created':
			case 'session.updated': {
				const parent = decoded.properties.info.parentID
				if (parent === undefined) return
				const root = activeRootForSession(state, parent)
				if (root !== undefined) state.childToRoot.set(decoded.properties.info.id, root)
				return
			}
			case 'session.deleted': {
				state.childToRoot.delete(decoded.properties.info.id)
				const turn = state.activeTurns.get(decoded.properties.info.id)
				const removeThread = () => {
					for (const [threadKey, thread] of state.threads) {
						if (thread.sessionID === decoded.properties.info.id) state.threads.delete(threadKey)
					}
				}
				if (turn === undefined) {
					removeThread()
					return
				}
				yield* semaphoreForThread(state, turn.threadKey).withPermits(1)(
					Effect.gen(function* () {
						removeThread()
						if (turn.cancelled) {
							yield* settleCancelledTurn(state, turn)
							return
						}
						if (turn.finishing) return
						turn.finishing = true
						yield* finishTurn(
							state,
							turn,
							turn.statusSemaphore.withPermits(1)(
								publishTerminalText(
									state,
									turn,
									'The OpenCode session for this Slack thread was deleted. Mention the bot again to start a fresh session.',
								),
							),
						)
					}),
				)
				return
			}
			case 'session.error': {
				const sessionID = decoded.properties.sessionID
				if (sessionID === undefined) return
				const turn = state.activeTurns.get(sessionID)
				if (turn === undefined) return
				yield* semaphoreForThread(state, turn.threadKey).withPermits(1)(
					Effect.gen(function* () {
						if (state.activeTurns.get(sessionID) !== turn) return
						if (turn.cancelled) {
							if (decoded.properties.error?.name !== 'ContextOverflowError')
								yield* settleCancelledTurn(state, turn)
							else if (turn.busyObserved) yield* abortStartedTurn(runner, turn)
							return
						}
						if (turn.finishing) return
						if (decoded.properties.error?.name === 'ContextOverflowError') return
						const results = yield* drainAssistantResults(plugin, state, turn).pipe(
							Effect.catch((error) =>
								Effect.logError(
									`[limitless] failed to drain Slack responses before terminal error: ${error.message}`,
								).pipe(Effect.andThen(Effect.succeed<ReadonlyArray<SlackAssistantResult>>([]))),
							),
						)
						turn.finishing = true
						yield* finishTurn(
							state,
							turn,
							results.at(-1)?.failed === true
								? Effect.void
								: turn.statusSemaphore.withPermits(1)(
										publishTerminalText(state, turn, SLACK_TURN_ERROR_MESSAGE),
									),
						)
					}),
				)
				return
			}
			case 'session.idle':
			case 'session.status': {
				const turn = state.activeTurns.get(decoded.properties.sessionID)
				if (turn === undefined) return
				if (decoded.type === 'session.status' && decoded.properties.status.type === 'busy') {
					turn.busyObserved = true
					turn.waitingForBusy = false
					turn.busyVersion += 1
					if (turn.cancelled) {
						turn.abortSent = false
						yield* abortStartedTurn(runner, turn)
					}
					return
				}
				if (decoded.type === 'session.status' && decoded.properties.status.type !== 'idle') return
				const eventGeneration = turn.generation
				const eventBusyVersion = turn.busyVersion
				yield* semaphoreForThread(state, turn.threadKey)
					.withPermits(1)(
						Effect.gen(function* () {
							if (state.activeTurns.get(turn.rootSessionID) !== turn) return
							if (eventGeneration !== turn.generation || eventBusyVersion !== turn.busyVersion)
								return
							if (turn.cancelled) {
								if (turn.inFlightAdmissions > 0) return
								yield* settleCancelledTurn(state, turn)
								return
							}
							if (turn.finishing || turn.waitingForBusy) return
							const results = yield* drainAssistantResults(plugin, state, turn)
							if (
								state.activeTurns.get(turn.rootSessionID) !== turn ||
								turn.cancelled ||
								turn.finishing ||
								eventGeneration !== turn.generation ||
								eventBusyVersion !== turn.busyVersion
							)
								return
							if (
								turn.steered &&
								turn.latestMessageID !== null &&
								(results.at(-1)?.parentID ?? null) !== turn.latestMessageID
							) {
								const thread = state.threads.get(turn.threadKey)
								if (thread === undefined) return
								const messageID = openCodeMessageID(thread.lastMessageID)
								thread.lastMessageID = messageID
								turn.waitingForBusy = true
								yield* startTrackedOpenCodeTurn(turn, config, plugin, messageID, [
									{
										type: 'text',
										text: '[Slack bridge: incorporate all preceding Slack messages and provide the final response.]',
									},
								])
								turn.latestMessageID = messageID
								turn.generation += 1
								if (turn.cancelled) {
									turn.abortSent = false
									yield* abortStartedTurn(runner, turn)
								}
								return
							}
							turn.finishing = true
							yield* finishTurn(
								state,
								turn,
								results.length === 0
									? publishTerminalText(state, turn, SLACK_TURN_ERROR_MESSAGE)
									: results.at(-1)?.failed === true
										? Effect.void
										: publishQueuedFiles(state, turn, options),
							)
						}),
					)
					.pipe(
						Effect.catch((error) => {
							if (turn.cancelled) {
								turn.abortSent = false
								return abortStartedTurn(runner, turn).pipe(Effect.asVoid)
							}
							if (state.activeTurns.get(turn.rootSessionID) !== turn || turn.finishing)
								return Effect.logError(
									`[limitless] Slack idle arbitration failed: ${error.message}`,
								)
							turn.finishing = true
							return finishTurn(
								state,
								turn,
								publishTerminalText(state, turn, SLACK_TURN_ERROR_MESSAGE),
							)
						}),
					)
				return
			}
			case 'permission.asked': {
				if (activeRootForSession(state, decoded.properties.sessionID) === undefined) return
				yield* rejectOpenCodePermission(
					plugin,
					decoded.properties.sessionID,
					decoded.properties.id,
				).pipe(
					Effect.catch((error) =>
						Effect.logError(`[limitless] failed to reject Slack permission: ${error.message}`),
					),
				)
				return
			}
		}
	})

	const updateStatus = Effect.fn('SlackRunner.updateStatus')(function* (
		sessionID: string,
		text: string,
	) {
		const root = activeRootForSession(state, sessionID)
		const turn = root === undefined ? undefined : state.activeTurns.get(root)
		if (turn === undefined)
			return yield* slackIntegrationError(
				'Slack status update',
				'slack_status is only available during an active Slack turn',
			)
		const status = text.trim()
		return yield* turn.statusSemaphore.withPermits(1)(
			Effect.gen(function* () {
				if (turn.cancelled || turn.finishing)
					return yield* slackIntegrationError(
						'Slack status update',
						'slack_status is only available during an active Slack turn',
					)
				const nextTrace = `${turn.traceText}\n${quotedTraceStatus(status)}`
				if (nextTrace.length > MAX_SLACK_MARKDOWN_CHARS) {
					const continuation = `${SLACK_THINKING_HEADER}\n${quotedTraceStatus(status)}`
					const continuationTs = yield* postSlackMessage(
						state,
						turn.channel,
						turn.threadTs,
						continuation,
						true,
					)
					turn.traceText = continuation
					turn.statusTs = continuationTs
				} else {
					yield* updateSlackMessage(state, turn.channel, turn.statusTs, nextTrace, true)
					turn.traceText = nextTrace
				}
				return SlackStatusResult.make({ ok: true, status })
			}),
		)
	})

	const attachFile = Effect.fn('SlackRunner.attachFile')(function* (
		sessionID: string,
		filePath: string,
		directory: string,
	) {
		const root = activeRootForSession(state, sessionID)
		const turn = root === undefined ? undefined : state.activeTurns.get(root)
		if (turn === undefined || turn.cancelled || turn.finishing)
			return yield* slackIntegrationError(
				'Slack file attachment',
				'slack_attach_file is only available during an active Slack turn',
			)
		const absolutePath = path.resolve(directory, filePath)
		return yield* state.outboundFilesSemaphore.withPermits(1)(
			Effect.gen(function* () {
				const handle = yield* Effect.tryPromise({
					try: () => open(absolutePath, 'r'),
					catch: (error) => integrationFailure('Slack file attachment open', error),
				})
				const stat = yield* Effect.acquireUseRelease(
					Effect.succeed(handle),
					(file) =>
						Effect.gen(function* () {
							const stat = yield* Effect.tryPromise({
								try: () => file.stat(),
								catch: (error) => integrationFailure('Slack file attachment stat', error),
							})
							if (!stat.isFile())
								return yield* slackIntegrationError(
									'Slack file attachment',
									'Only regular files can be attached to Slack',
								)
							if (stat.size === 0 || stat.size > MAX_SLACK_OUTBOUND_FILE_BYTES)
								return yield* slackIntegrationError(
									'Slack file attachment',
									`File size must be between 1 and ${MAX_SLACK_OUTBOUND_FILE_BYTES} bytes`,
								)
							const previous = turn.queuedFiles.get(absolutePath)
							if (
								previous === undefined &&
								turn.queuedFiles.size >= MAX_SLACK_OUTBOUND_FILES_PER_TURN
							)
								return yield* slackIntegrationError(
									'Slack file attachment',
									`At most ${MAX_SLACK_OUTBOUND_FILES_PER_TURN} files can be attached to one response`,
								)
							const reservation = stat.size - (previous?.bytes.byteLength ?? 0)
							if (turn.queuedFileBytes + reservation > MAX_SLACK_OUTBOUND_BYTES_PER_TURN)
								return yield* slackIntegrationError(
									'Slack file attachment',
									`Queued files exceed the ${MAX_SLACK_OUTBOUND_BYTES_PER_TURN}-byte aggregate limit`,
								)
							if (state.queuedOutboundBytes + reservation > MAX_SLACK_OUTBOUND_BYTES_PROCESS)
								return yield* slackIntegrationError(
									'Slack file attachment',
									'Limitless has reached the process-wide Slack attachment memory limit',
								)
							const bytes = yield* Effect.tryPromise({
								try: () => file.readFile(),
								catch: (error) => integrationFailure('Slack file attachment read', error),
							})
							if (
								bytes.byteLength !== stat.size ||
								bytes.byteLength > MAX_SLACK_OUTBOUND_FILE_BYTES
							)
								return yield* slackIntegrationError(
									'Slack file attachment',
									'File changed while it was being attached; attach it again',
								)
							return { bytes, previous }
						}),
					(file) => Effect.promise(() => file.close()).pipe(Effect.ignore),
				)
				if (state.activeTurns.get(turn.rootSessionID) !== turn || turn.cancelled || turn.finishing)
					return yield* slackIntegrationError(
						'Slack file attachment',
						'slack_attach_file is only available during an active Slack turn',
					)
				const nextBytes =
					turn.queuedFileBytes - (stat.previous?.bytes.byteLength ?? 0) + stat.bytes.byteLength
				const filename = path.basename(absolutePath)
				turn.queuedFiles.set(absolutePath, { path: absolutePath, filename, bytes: stat.bytes })
				state.queuedOutboundBytes += stat.bytes.byteLength - (stat.previous?.bytes.byteLength ?? 0)
				turn.queuedFileBytes = nextBytes
				return SlackAttachFileResult.make({
					ok: true,
					path: absolutePath,
					filename,
					bytes: stat.bytes.byteLength,
					status: stat.previous === undefined ? 'queued' : 'replaced',
				})
			}),
		)
	})

	return {
		enabled: config.enabled,
		start,
		stop,
		handleMention,
		handleOpenCodeEvent,
		updateStatus,
		attachFile,
		shouldDenyPermission: (sessionID: string) =>
			Effect.sync(() => activeRootForSession(state, sessionID) !== undefined),
	} satisfies SlackRunner
})
