import type { Plugin, PluginOptions } from '@opencode-ai/plugin'
import { Effect } from 'effect'
import { applyCodexIdentityHeaders } from './integrations/identity/index'
import {
	createNotificationRunner,
	DISABLED_NOTIFICATION_CONFIG,
	normalizeNotificationConfig,
} from './integrations/notifications/index'
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
	const githubConfig = yield* resolveGitHubConfig(options)
	const githubCloneRuntime = yield* makeGitHubCloneRuntime()
	return { notifications, githubConfig, githubCloneRuntime }
})

function runNotificationHook(name: string, effect: Effect.Effect<unknown>) {
	return Effect.runPromise(
		effect.pipe(
			Effect.catchDefect((defect) =>
				Effect.logError(`[limitless] notification hook ${name} failed`, defect),
			),
			Effect.asVoid,
		),
	)
}

export function createLimitless(): Plugin {
	return async (pluginInput, options) => {
		const { githubCloneRuntime, githubConfig, notifications } = await Effect.runPromise(
			resolvePluginConfigs(options),
		)
		return {
			'chat.headers': async (input, output) => {
				applyCodexIdentityHeaders(input.model.providerID, output.headers)
			},
			event: ({ event }) => runNotificationHook('event', notifications.handleEvent(event)),
			'tool.execute.before': (input) =>
				runNotificationHook(
					'tool.execute.before',
					input.tool === 'question' ? notifications.notify('question') : Effect.void,
				),
			tool: {
				...artifactTools(),
				...astGrepTools(),
				...diagnosticsTools(),
				...lspTools(pluginInput),
				...githubTools(githubConfig, githubCloneRuntime),
			},
		}
	}
}

export default createLimitless()
