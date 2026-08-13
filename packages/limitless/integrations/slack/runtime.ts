import { realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PluginInput } from '@opencode-ai/plugin'
import { App } from '@slack/bolt'
import { WebClient } from '@slack/web-api'
import { type Deferred, Effect, Semaphore } from 'effect'
import type { SlackConfig } from './config'

export type SlackQueuedFile = {
	readonly path: string
	readonly filename: string
	readonly bytes: Buffer
}

export type SlackMentionDispatcher = (input: unknown) => Promise<void>

export type SlackAppHandle = {
	readonly client: App['client']
	readonly start: () => Promise<unknown>
	readonly stop: () => Promise<unknown>
}

export type SlackAppFactory = (
	botToken: string,
	appToken: string,
	dispatch: SlackMentionDispatcher,
) => SlackAppHandle

export type SlackRunnerOptions = {
	readonly env: Readonly<Record<string, string | undefined>>
	readonly resolveDirectory: (directory: string) => Promise<string>
	readonly fetch: typeof globalThis.fetch
	readonly makeApp: SlackAppFactory
	readonly makeUploadClient: (botToken: string) => WebClient
	readonly readyFile: string | null
	readonly markReady: (filePath: string, directory: string) => Promise<void>
	readonly clearReady: (filePath: string) => Promise<void>
}

export type SlackThreadState = {
	readonly sessionID: string
	lastImportedTs: string | undefined
	lastMessageID: string | undefined
}

export type SlackPendingTurn = {
	cancelled: boolean
	readonly abort: AbortController
	readonly cancelRequested: Deferred.Deferred<void>
}

export type SlackActiveTurn = {
	readonly rootSessionID: string
	readonly threadKey: string
	readonly channel: string
	readonly threadTs: string
	statusTs: string
	traceText: string
	readonly done: Deferred.Deferred<void>
	readonly statusSemaphore: Semaphore.Semaphore
	messageID: string | null
	latestMessageID: string | null
	launchState: 'not-started' | 'starting' | 'started'
	busyObserved: boolean
	waitingForBusy: boolean
	abortSent: boolean
	steered: boolean
	generation: number
	busyVersion: number
	inFlightAdmissions: number
	readonly deliveredAssistantIDs: Set<string>
	readonly assistantChunkProgress: Map<string, number>
	readonly queuedFiles: Map<string, SlackQueuedFile>
	queuedFileBytes: number
	cancelled: boolean
	finishing: boolean
}

export type SlackRuntimeState = {
	app: SlackAppHandle | null
	uploadClient: WebClient | null
	botToken: string | null
	botUserID: string | null
	teamID: string | null
	readyFileOwned: boolean
	readonly threads: Map<string, SlackThreadState>
	readonly pendingTurns: Map<string, Set<SlackPendingTurn>>
	readonly activeTurns: Map<string, SlackActiveTurn>
	readonly childToRoot: Map<string, string>
	readonly cancelledThroughTs: Map<string, string>
	readonly seenEventIDs: Set<string>
	readonly seenEventOrder: Array<string>
	readonly threadSemaphores: Map<string, Semaphore.Semaphore>
	readonly outboundFilesSemaphore: Semaphore.Semaphore
	readonly outboundUploadSemaphore: Semaphore.Semaphore
	queuedOutboundBytes: number
}

export const DEFAULT_SLACK_RUNNER_OPTIONS: SlackRunnerOptions = {
	env: process.env,
	resolveDirectory: realpath,
	fetch: globalThis.fetch,
	readyFile:
		process.env.XDG_RUNTIME_DIR === undefined
			? null
			: path.join(process.env.XDG_RUNTIME_DIR, 'limitless-slack-ready'),
	markReady: (filePath, directory) =>
		writeFile(filePath, `${directory}\n`, { encoding: 'utf8', mode: 0o600 }),
	clearReady: (filePath) => rm(filePath, { force: true }),
	makeApp: (botToken, appToken, dispatch) => {
		const app = new App({ token: botToken, appToken, socketMode: true, ignoreSelf: true })
		app.event('app_mention', (input) => dispatch({ body: input.body, event: input.event }))
		return {
			client: app.client,
			start: () => app.start(),
			stop: () => app.stop(),
		}
	},
	makeUploadClient: (botToken) =>
		new WebClient(botToken, {
			fetch: globalThis.fetch,
			retryConfig: { retries: 0 },
			rejectRateLimitedCalls: true,
			timeout: 10 * 60 * 1000,
		}),
}

export const makeSlackRuntimeState = Effect.sync(() => {
	const state: SlackRuntimeState = {
		app: null,
		uploadClient: null,
		botToken: null,
		botUserID: null,
		teamID: null,
		readyFileOwned: false,
		threads: new Map(),
		pendingTurns: new Map(),
		activeTurns: new Map(),
		childToRoot: new Map(),
		cancelledThroughTs: new Map(),
		seenEventIDs: new Set(),
		seenEventOrder: [],
		threadSemaphores: new Map(),
		outboundFilesSemaphore: Semaphore.makeUnsafe(1),
		outboundUploadSemaphore: Semaphore.makeUnsafe(1),
		queuedOutboundBytes: 0,
	}
	return state
})

export type SlackPluginContext = Pick<PluginInput, 'client' | 'directory'>
export type SlackRunnerConfig = {
	readonly config: SlackConfig
	readonly plugin: SlackPluginContext
	readonly options: SlackRunnerOptions
	readonly state: SlackRuntimeState
}
