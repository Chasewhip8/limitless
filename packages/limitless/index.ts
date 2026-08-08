import type { Plugin, PluginOptions } from '@opencode-ai/plugin'
import { Effect } from 'effect'
import {
	createNotificationRunner,
	DISABLED_NOTIFICATION_CONFIG,
	normalizeNotificationConfig,
} from './integrations/notifications/index'
import { createSlackRunner, normalizeSlackConfig, slackTools } from './integrations/slack/index'
import { artifactTools } from './tools/artifacts/index'
import { astGrepTools } from './tools/ast-grep'
import { diagnosticsTools } from './tools/diagnostics'
import {
	DISABLED_GITHUB_CONFIG,
	githubTools,
	makeGitHubCloneRuntime,
	normalizeGitHubPluginConfig,
} from './tools/github/index'
import { lspTools } from './tools/lsp/index'

export const resolveNotificationConfig = Effect.fn('resolveNotificationConfig')(function* (
	options: PluginOptions | undefined,
) {
	return yield* normalizeNotificationConfig(options).pipe(
		Effect.catchTag('NotificationConfigError', (error) =>
			Effect.logWarning(`[limitless] invalid notifications config: ${error.message}`).pipe(
				Effect.as(DISABLED_NOTIFICATION_CONFIG),
			),
		),
	)
})

export const resolveGitHubConfig = Effect.fn('resolveGitHubConfig')(function* (
	options: PluginOptions | undefined,
) {
	return yield* normalizeGitHubPluginConfig(options).pipe(
		Effect.catchTag('GitHubConfigError', (error) =>
			Effect.logWarning(`[limitless] invalid github config: ${error.message}`).pipe(
				Effect.as(DISABLED_GITHUB_CONFIG),
			),
		),
	)
})

export const resolvePluginConfigs = Effect.fn('resolvePluginConfigs')(function* (
	options: PluginOptions | undefined,
) {
	const notificationConfig = yield* resolveNotificationConfig(options)
	const notifications = yield* createNotificationRunner(notificationConfig)
	const slackConfig = yield* normalizeSlackConfig(options)
	const githubConfig = yield* resolveGitHubConfig(options)
	const githubCloneRuntime = yield* makeGitHubCloneRuntime()
	return { notifications, slackConfig, githubConfig, githubCloneRuntime }
})

function runPluginHook(name: string, effect: Effect.Effect<unknown>) {
	return Effect.runPromise(
		effect.pipe(
			Effect.catchDefect((defect) =>
				Effect.logError(`[limitless] plugin hook ${name} failed`, defect),
			),
			Effect.asVoid,
		),
	)
}

export function createLimitless(): Plugin {
	return async (pluginInput, options) => {
		const { githubCloneRuntime, githubConfig, notifications, slackConfig } =
			await Effect.runPromise(resolvePluginConfigs(options))
		const slack = await Effect.runPromise(createSlackRunner(slackConfig, pluginInput))
		const dispatchSlackMention = (input: unknown) => {
			setImmediate(() => {
				void runPluginHook('slack.app_mention', slack.handleMention(input))
			})
			return Promise.resolve()
		}
		let slackStart: Promise<void> | undefined
		const ensureSlackStarted = () => {
			slackStart ??= Effect.runPromise(
				slack
					.start(dispatchSlackMention)
					.pipe(
						Effect.catch((error) =>
							Effect.logError(`[limitless] ${error.operation}: ${error.message}`),
						),
					),
			)
			return slackStart
		}
		return {
			dispose: () => runPluginHook('dispose', slack.stop),
			event: async ({ event }) => {
				await ensureSlackStarted()
				return runPluginHook(
					'event',
					Effect.all([notifications.handleEvent(event), slack.handleOpenCodeEvent(event)], {
						discard: true,
					}),
				)
			},
			'tool.execute.before': (input) =>
				runPluginHook(
					'tool.execute.before',
					input.tool === 'question' ? notifications.notify('question') : Effect.void,
				),
			tool: {
				...artifactTools(),
				...astGrepTools(),
				...diagnosticsTools(),
				...lspTools(pluginInput),
				...githubTools(githubConfig, githubCloneRuntime),
				...slackTools(slack),
			},
		}
	}
}

export default createLimitless()
