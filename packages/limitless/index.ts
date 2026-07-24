import { Plugin } from '@opencode-ai/plugin/v2/effect'
import { Tool } from '@opencode-ai/plugin/v2/effect/tool'
import { Session } from '@opencode-ai/schema/session'
import { Effect, Stream } from 'effect'
import {
	createNotificationRunner,
	NotificationSessionLookupError,
	normalizeNotificationConfig,
} from './integrations/notifications/index'
import {
	makeToolExecutor,
	type SessionDirectoryResolver,
	type ToolExecutor,
} from './plugin/tool-boundary'
import { artifactTools } from './tools/artifacts/index'
import { astGrepTools } from './tools/ast-grep'
import { diagnosticsTools } from './tools/diagnostics'
import {
	githubTools,
	makeGitHubCloneRuntime,
	normalizeGitHubPluginConfig,
} from './tools/github/index'
import { decodeLspConfig, lspTools } from './tools/lsp/index'

export const resolveNotificationConfig = normalizeNotificationConfig
export const resolveGitHubConfig = normalizeGitHubPluginConfig

export const resolvePluginConfigs = Effect.fn('resolvePluginConfigs')(function* (options: unknown) {
	const notificationConfig = yield* normalizeNotificationConfig(options)
	const notifications = yield* createNotificationRunner(notificationConfig)
	const githubConfig = yield* normalizeGitHubPluginConfig(options)
	const githubCloneRuntime = yield* makeGitHubCloneRuntime()
	const lspConfig = yield* decodeLspConfig(options)
	return {
		notifications,
		githubConfig,
		githubCloneRuntime,
		lspConfig,
	}
})

export function limitlessTools(
	executeTool: ToolExecutor,
	githubConfig: Parameters<typeof githubTools>[1],
	githubCloneRuntime: Parameters<typeof githubTools>[2],
) {
	return {
		...artifactTools(executeTool),
		...astGrepTools(executeTool),
		...diagnosticsTools(executeTool),
		...lspTools(executeTool),
		...githubTools(executeTool, githubConfig, githubCloneRuntime),
	}
}

export function registerLimitlessTools(
	draft: Tool.ToolDraft,
	tools: ReturnType<typeof limitlessTools>,
): void {
	for (const [name, definition] of Object.entries(tools)) {
		draft.add(name, definition, { codemode: false })
	}
}

export function makeSessionDirectoryResolver(
	session: Pick<Plugin.Context['session'], 'get'>,
): SessionDirectoryResolver {
	return (sessionID) =>
		session.get({ sessionID }).pipe(
			Effect.map((info) => info.location.directory),
			Effect.mapError(
				() =>
					new Tool.Failure({
						message: 'Unable to resolve the OpenCode session directory.',
					}),
			),
		)
}

export default Plugin.define({
	id: 'limitless',
	effect: Effect.fn('limitless.plugin')(function* (ctx) {
		const configs = yield* resolvePluginConfigs(ctx.options).pipe(
			Effect.tapError((error) =>
				Effect.logError(`[limitless] plugin configuration is invalid: ${error.message}`),
			),
			Effect.orDie,
		)
		const executeTool = makeToolExecutor(
			makeSessionDirectoryResolver(ctx.session),
			configs.lspConfig,
		)
		const tools = limitlessTools(executeTool, configs.githubConfig, configs.githubCloneRuntime)

		yield* ctx.tool.transform((draft) => {
			registerLimitlessTools(draft, tools)
		})

		const lookupNotificationSession = (sessionID: string) =>
			ctx.session.get({ sessionID: Session.ID.make(sessionID) }).pipe(
				Effect.map((session) =>
					session.parentID === undefined ? {} : { parentID: session.parentID },
				),
				Effect.mapError(
					() =>
						new NotificationSessionLookupError({
							message: `Unable to resolve session ${sessionID}.`,
						}),
				),
			)
		yield* ctx.event.subscribe().pipe(
			Stream.runForEach((event) =>
				configs.notifications.handleEvent(event, lookupNotificationSession),
			),
			Effect.catchCause((cause) =>
				Effect.logError('[limitless] OpenCode notification event stream stopped', cause),
			),
			Effect.forkScoped({ startImmediately: true }),
		)
	}),
})
