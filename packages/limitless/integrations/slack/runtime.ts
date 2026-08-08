import { realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PluginInput } from '@opencode-ai/plugin'
import { App } from '@slack/bolt'
import { type Deferred, Effect, type Semaphore } from 'effect'
import type { SlackConfig } from './config'

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
	readonly readyFile: string | null
	readonly markReady: (filePath: string, directory: string) => Promise<void>
	readonly clearReady: (filePath: string) => Promise<void>
}

export type SlackThreadState = {
	readonly sessionID: string
	lastImportedTs: string | undefined
}

export type SlackPendingTurn = {
	cancelled: boolean
	readonly abort: AbortController
}

export type SlackActiveTurn = {
	readonly rootSessionID: string
	readonly threadKey: string
	readonly channel: string
	readonly threadTs: string
	readonly statusTs: string
	readonly done: Deferred.Deferred<void>
	readonly launchSettled: Deferred.Deferred<void>
	readonly cancelRequested: Deferred.Deferred<void>
	readonly preparationAbort: AbortController
	readonly statusSemaphore: Semaphore.Semaphore
	readonly messageID: string
	launchState: 'not-started' | 'starting' | 'started'
	busyObserved: boolean
	lastStatus: string
	cancelled: boolean
	finishing: boolean
}

export type SlackRuntimeState = {
	app: SlackAppHandle | null
	botToken: string | null
	botUserID: string | null
	teamID: string | null
	readyFileOwned: boolean
	readonly threads: Map<string, SlackThreadState>
	readonly pendingTurns: Map<string, SlackPendingTurn>
	readonly activeTurns: Map<string, SlackActiveTurn>
	readonly childToRoot: Map<string, string>
	readonly seenEventIDs: Set<string>
	readonly seenEventOrder: Array<string>
	readonly threadSemaphores: Map<string, Semaphore.Semaphore>
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
}

export const makeSlackRuntimeState = Effect.sync(() => {
	const state: SlackRuntimeState = {
		app: null,
		botToken: null,
		botUserID: null,
		teamID: null,
		readyFileOwned: false,
		threads: new Map(),
		pendingTurns: new Map(),
		activeTurns: new Map(),
		childToRoot: new Map(),
		seenEventIDs: new Set(),
		seenEventOrder: [],
		threadSemaphores: new Map(),
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
