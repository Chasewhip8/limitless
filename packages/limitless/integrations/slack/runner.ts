import { Deferred, Effect, Option, Schema, Semaphore } from 'effect'
import { describeUnknown, schemaErrorMessage } from '../../lib/guards'
import { SLACK_SERVICE_ACTIVATION_ENV, type SlackConfig } from './config'
import { type SlackIntegrationError, slackIntegrationError } from './errors'
import {
	chunkSlackMarkdown,
	compareSlackMessages,
	fetchSlackThread,
	isAfterSlackTimestamp,
	prepareSlackMessageParts,
	selectSlackImageIDs,
} from './history'
import {
	DEFAULT_SLACK_RUNNER_OPTIONS,
	makeSlackRuntimeState,
	type SlackActiveTurn,
	type SlackMentionDispatcher,
	type SlackPluginContext,
	type SlackRunnerConfig,
	type SlackRunnerOptions,
	type SlackRuntimeState,
} from './runtime'
import {
	type SlackAppMentionInput,
	SlackAppMentionInput as SlackAppMentionInputSchema,
	SlackMessage,
	SlackOpenCodeEvent,
	SlackOpenCodeEventEnvelope,
	type SlackPromptPart,
	SlackStatusResult,
	type SlackStatusResult as SlackStatusResultType,
} from './schema'

const MAX_SEEN_SLACK_EVENTS = 1_000
const SLACK_TURN_ERROR_MESSAGE =
	'OpenCode reported an error while processing this turn. Check the Limitless service logs.'
const OPEN_CODE_ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function openCodeMessageID(): string {
	const value = BigInt(Date.now()) * 0x1000n
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

function duringPreparation<A, E, R>(
	turn: SlackActiveTurn,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, E, R> {
	return Effect.raceFirst(
		effect.pipe(Effect.map(Option.some)),
		Deferred.await(turn.cancelRequested).pipe(Effect.as(Option.none<A>())),
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
) {
	const app = yield* slackApp(state)
	const response = yield* Effect.tryPromise({
		try: () => app.client.chat.postMessage({ channel, thread_ts: threadTs, text }),
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

const appendOpenCodeContext = Effect.fn('appendOpenCodeContext')(function* (
	config: SlackConfig,
	context: SlackPluginContext,
	sessionID: string,
	parts: ReadonlyArray<SlackPromptPart>,
) {
	yield* Effect.tryPromise({
		try: () =>
			context.client.session.prompt({
				path: { id: sessionID },
				body: { agent: config.agent, noReply: true, parts: openCodeParts(parts) },
				throwOnError: true,
			}),
		catch: (error) => integrationFailure('OpenCode context append', error),
	})
})

const startOpenCodeTurn = Effect.fn('startOpenCodeTurn')(function* (
	config: SlackConfig,
	context: SlackPluginContext,
	sessionID: string,
	messageID: string,
	parts: ReadonlyArray<SlackPromptPart>,
) {
	yield* Effect.tryPromise({
		try: () =>
			context.client.session.promptAsync({
				path: { id: sessionID },
				body: {
					messageID,
					agent: config.agent,
					tools: { question: false, slack_status: true },
					parts: openCodeParts(parts),
				},
				throwOnError: true,
			}),
		catch: (error) => integrationFailure('OpenCode turn start', error),
	})
})

const abortOpenCodeTurn = Effect.fn('abortOpenCodeTurn')(function* (
	context: SlackPluginContext,
	sessionID: string,
) {
	yield* Effect.tryPromise({
		try: () => context.client.session.abort({ path: { id: sessionID }, throwOnError: true }),
		catch: (error) => integrationFailure('OpenCode turn cancellation', error),
	})
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

const latestAssistantResult = Effect.fn('latestAssistantResult')(function* (
	context: SlackPluginContext,
	turn: SlackActiveTurn,
) {
	const response = yield* Effect.tryPromise({
		try: () =>
			context.client.session.messages({
				path: { id: turn.rootSessionID },
				throwOnError: true,
			}),
		catch: (error) => integrationFailure('OpenCode response retrieval', error),
	})
	for (const message of [...response.data].reverse()) {
		if (message.info.role !== 'assistant') continue
		if (message.info.id <= turn.messageID) continue
		const textParts: Array<string> = []
		for (const part of message.parts)
			if (part.type === 'text' && part.ignored !== true) textParts.push(part.text)
		const text = textParts.join('\n').trim()
		return { failed: message.info.error !== undefined, text }
	}
	return { failed: true, text: '' }
})

const publishFinalResponse = Effect.fn('publishFinalResponse')(function* (
	context: SlackPluginContext,
	state: SlackRuntimeState,
	turn: SlackActiveTurn,
) {
	const result = yield* latestAssistantResult(context, turn)
	if (result.failed || result.text.length === 0) {
		yield* updateSlackMessage(state, turn.channel, turn.statusTs, SLACK_TURN_ERROR_MESSAGE, false)
		return
	}
	const text = result.text
	const chunks = chunkSlackMarkdown(text)
	const first = chunks[0] ?? 'Completed without a textual response.'
	yield* updateSlackMessage(state, turn.channel, turn.statusTs, first, true)
	for (const chunk of chunks.slice(1))
		yield* postSlackMessage(state, turn.channel, turn.threadTs, chunk)
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
				Effect.andThen(Deferred.succeed(turn.launchSettled, undefined)),
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
		updateSlackMessage(
			state,
			turn.channel,
			turn.statusTs,
			'OpenCode could not complete this turn. Check the Limitless service logs.',
			false,
		).pipe(
			Effect.catch((updateError) =>
				Effect.logError(`[limitless] failed to report Slack turn failure: ${updateError.message}`),
			),
		),
	)
	cleanupTurn(state, turn)
	yield* Deferred.succeed(turn.launchSettled, undefined)
	yield* Deferred.succeed(turn.done, undefined)
})

const settleCancelledTurn = Effect.fn('settleCancelledTurn')(function* (
	state: SlackRuntimeState,
	turn: SlackActiveTurn,
) {
	turn.finishing = true
	cleanupTurn(state, turn)
	yield* Deferred.succeed(turn.launchSettled, undefined)
	yield* Deferred.succeed(turn.done, undefined)
})

const abortStartedTurn = Effect.fn('abortStartedTurn')(function* (
	runner: SlackRunnerConfig,
	turn: SlackActiveTurn,
) {
	if (turn.launchState !== 'started') return
	yield* abortOpenCodeTurn(runner.plugin, turn.rootSessionID).pipe(
		Effect.catch((error) =>
			Effect.logError(`[limitless] Slack cancellation failed: ${error.message}`),
		),
	)
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

const processSlackTurn = Effect.fn('processSlackTurn')(function* (
	runner: SlackRunnerConfig,
	input: SlackAppMentionInput,
	threadKey: string,
	threadTs: string,
) {
	const { config, options, plugin, state } = runner
	const pending = { cancelled: false, abort: new AbortController() }
	state.pendingTurns.set(threadKey, pending)
	let thread = state.threads.get(threadKey)
	const existingSession = thread !== undefined
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
						).pipe(
							Effect.catch(() => Effect.void),
							Effect.andThen(Effect.logError(`[limitless] ${error.operation}: ${error.message}`)),
							Effect.as(undefined),
						),
			),
		)
		if (sessionID === undefined) {
			state.pendingTurns.delete(threadKey)
			return
		}
		thread = { sessionID, lastImportedTs: undefined }
		state.threads.set(threadKey, thread)
	}
	if (pending.cancelled) {
		state.pendingTurns.delete(threadKey)
		return
	}
	const statusTs = yield* postSlackMessage(state, input.event.channel, threadTs, 'Working…').pipe(
		Effect.onError(() =>
			Effect.sync(() => {
				state.pendingTurns.delete(threadKey)
			}),
		),
	)
	const done = yield* Deferred.make<void>()
	const launchSettled = yield* Deferred.make<void>()
	const cancelRequested = yield* Deferred.make<void>()
	const turn: SlackActiveTurn = {
		rootSessionID: thread.sessionID,
		threadKey,
		channel: input.event.channel,
		threadTs,
		statusTs,
		done,
		launchSettled,
		cancelRequested,
		preparationAbort: new AbortController(),
		statusSemaphore: Semaphore.makeUnsafe(1),
		messageID: openCodeMessageID(),
		launchState: 'not-started',
		busyObserved: false,
		lastStatus: 'Working…',
		cancelled: pending.cancelled,
		finishing: false,
	}
	state.activeTurns.set(thread.sessionID, turn)
	state.pendingTurns.delete(threadKey)
	if (turn.cancelled) {
		turn.finishing = true
		yield* updateSlackMessage(
			state,
			turn.channel,
			turn.statusTs,
			`Cancelled by <@${input.event.user}>.`,
			false,
		).pipe(Effect.catch(() => Effect.void))
		yield* settleCancelledTurn(state, turn)
		return
	}

	const execute = Effect.gen(function* () {
		const fetchedResult = yield* duringPreparation(
			turn,
			fetchSlackThread(
				state.app as NonNullable<SlackRuntimeState['app']>,
				input.event.channel,
				threadTs,
				input.event.ts,
				thread.lastImportedTs,
			),
		)
		if (Option.isNone(fetchedResult)) {
			yield* Deferred.await(done)
			return
		}
		const fetched = fetchedResult.value
		const byTimestamp = new Map(fetched.map((message) => [message.ts, message]))
		if (!byTimestamp.has(input.event.ts)) byTimestamp.set(input.event.ts, mentionAsMessage(input))
		const messages = [...byTimestamp.values()]
			.filter(
				(message) =>
					isAfterSlackTimestamp(message.ts, thread.lastImportedTs) &&
					Number(message.ts) <= Number(input.event.ts) &&
					message.ts !== statusTs,
			)
			.sort(compareSlackMessages)
		const selectedImages = selectSlackImageIDs(messages, input.event.ts)
		const consumedImages = new Set<string>()
		const botUserID = state.botUserID as string
		const botToken = state.botToken as string
		let triggerStarted = false
		for (const message of messages) {
			if (turn.cancelled) {
				yield* settleCancelledTurn(state, turn)
				return
			}
			if (existingSession && message.user === botUserID && message.ts !== input.event.ts) {
				thread.lastImportedTs = message.ts
				continue
			}
			const isTrigger = message.ts === input.event.ts
			const override = isTrigger ? stripSlackBotMention(input.event.text, botUserID) : undefined
			const prepared = yield* duringPreparation(
				turn,
				prepareSlackMessageParts(
					message,
					selectedImages,
					consumedImages,
					botUserID,
					botToken,
					options,
					turn.preparationAbort.signal,
					override,
				),
			)
			if (Option.isNone(prepared)) {
				yield* Deferred.await(done)
				return
			}
			const parts = prepared.value
			if (isTrigger) {
				turn.launchState = 'starting'
				yield* startOpenCodeTurn(config, plugin, thread.sessionID, turn.messageID, parts).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							turn.launchState = 'started'
						}),
					),
					Effect.ensuring(Deferred.succeed(turn.launchSettled, undefined)),
				)
				triggerStarted = true
				thread.lastImportedTs = message.ts
				if (turn.cancelled) {
					yield* Deferred.await(done)
					return
				}
			} else {
				const appended = yield* duringPreparation(
					turn,
					appendOpenCodeContext(config, plugin, thread.sessionID, parts),
				)
				if (Option.isNone(appended)) {
					yield* Deferred.await(done)
					return
				}
			}
			if (!isTrigger) thread.lastImportedTs = message.ts
		}
		if (!triggerStarted)
			return yield* slackIntegrationError(
				'Slack turn preparation',
				'The triggering Slack message was not available',
			)
		yield* Deferred.await(done)
	})

	yield* execute.pipe(Effect.catch((error) => failTurn(state, turn, error)))
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
	if (turn === undefined && pending !== undefined) {
		pending.cancelled = true
		pending.abort.abort()
		yield* postSlackMessage(
			runner.state,
			input.event.channel,
			threadTs,
			`Cancelled by <@${input.event.user}>.`,
		)
		return
	}
	if (turn === undefined || turn.finishing) {
		yield* postSlackMessage(
			runner.state,
			input.event.channel,
			threadTs,
			'Nothing is currently running in this thread.',
		)
		return
	}
	turn.cancelled = true
	turn.finishing = true
	turn.preparationAbort.abort()
	yield* Deferred.succeed(turn.cancelRequested, undefined)
	yield* turn.statusSemaphore.withPermits(1)(
		updateSlackMessage(
			runner.state,
			turn.channel,
			turn.statusTs,
			`Cancelled by <@${input.event.user}>.`,
			false,
		).pipe(
			Effect.catch((error) =>
				Effect.logError(`[limitless] failed to report Slack cancellation: ${error.message}`),
			),
		),
	)
	if (turn.launchState === 'starting') yield* Deferred.await(turn.launchSettled)
	if (turn.launchState === 'started') {
		if (turn.busyObserved) yield* abortStartedTurn(runner, turn)
		return
	}
	yield* settleCancelledTurn(runner.state, turn)
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
		for (const pending of state.pendingTurns.values()) {
			pending.cancelled = true
			pending.abort.abort()
		}
		state.pendingTurns.clear()
		for (const turn of state.activeTurns.values()) {
			turn.cancelled = true
			turn.preparationAbort.abort()
			yield* Deferred.succeed(turn.cancelRequested, undefined)
			yield* Deferred.succeed(turn.launchSettled, undefined)
			yield* Deferred.succeed(turn.done, undefined)
		}
		state.activeTurns.clear()
		state.childToRoot.clear()
		const app = state.app
		state.app = null
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
		yield* semaphoreForThread(state, threadKey)
			.withPermits(1)(processSlackTurn(runner, decoded, threadKey, threadTs))
			.pipe(
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
				for (const [threadKey, thread] of state.threads) {
					if (thread.sessionID === decoded.properties.info.id) state.threads.delete(threadKey)
				}
				const turn = state.activeTurns.get(decoded.properties.info.id)
				if (turn?.cancelled) {
					yield* settleCancelledTurn(state, turn)
					return
				}
				if (turn !== undefined && !turn.finishing) {
					turn.finishing = true
					yield* finishTurn(
						state,
						turn,
						turn.statusSemaphore.withPermits(1)(
							updateSlackMessage(
								state,
								turn.channel,
								turn.statusTs,
								'The OpenCode session for this Slack thread was deleted. Mention the bot again to start a fresh session.',
								false,
							),
						),
					)
				}
				return
			}
			case 'session.error': {
				const sessionID = decoded.properties.sessionID
				if (sessionID === undefined) return
				const turn = state.activeTurns.get(sessionID)
				if (turn === undefined) return
				if (turn.cancelled) {
					if (decoded.properties.error?.name !== 'ContextOverflowError')
						yield* settleCancelledTurn(state, turn)
					else if (turn.busyObserved) yield* abortStartedTurn(runner, turn)
					return
				}
				if (turn.finishing) return
				if (decoded.properties.error?.name === 'ContextOverflowError') return
				turn.finishing = true
				yield* finishTurn(
					state,
					turn,
					turn.statusSemaphore.withPermits(1)(
						updateSlackMessage(state, turn.channel, turn.statusTs, SLACK_TURN_ERROR_MESSAGE, false),
					),
				)
				return
			}
			case 'session.idle':
			case 'session.status': {
				const turn = state.activeTurns.get(decoded.properties.sessionID)
				if (turn === undefined) return
				if (decoded.type === 'session.status' && decoded.properties.status.type === 'busy') {
					turn.busyObserved = true
					if (turn.cancelled) yield* abortStartedTurn(runner, turn)
					return
				}
				if (decoded.type === 'session.status' && decoded.properties.status.type !== 'idle') return
				if (turn.cancelled) {
					if (turn.launchState !== 'started' || turn.busyObserved)
						yield* settleCancelledTurn(state, turn)
					return
				}
				if (turn.finishing) return
				turn.finishing = true
				yield* finishTurn(
					state,
					turn,
					turn.statusSemaphore.withPermits(1)(publishFinalResponse(plugin, state, turn)),
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
				if (status !== turn.lastStatus) {
					yield* updateSlackMessage(state, turn.channel, turn.statusTs, status, false)
					turn.lastStatus = status
				}
				return SlackStatusResult.make({ ok: true, status })
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
		shouldDenyPermission: (sessionID: string) =>
			Effect.sync(() => activeRootForSession(state, sessionID) !== undefined),
	} satisfies SlackRunner
})
