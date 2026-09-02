import { Plugin } from '@opencode-ai/plugin/effect'
import type { ToolDraft } from '@opencode-ai/plugin/effect/tool'
import { Session } from '@opencode-ai/schema/session'
import { Tool } from '@opencode-ai/schema/tool'
import { Effect, Schema, type Scope, Stream } from 'effect'
import {
	createNotificationRunner,
	NotificationSessionLookupError,
	normalizeNotificationConfig,
} from './integrations/notifications/index'
import {
	createSlackRunner,
	normalizeSlackConfig,
	type SlackRunner,
	slackTools,
} from './integrations/slack/index'
import { applyProviderPolicy, normalizeProviderPolicyConfig } from './plugin/provider-policy'
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
export const resolveSlackConfig = normalizeSlackConfig

export const resolvePluginConfigs = Effect.fn('resolvePluginConfigs')(function* (options: unknown) {
	const notificationConfig = yield* normalizeNotificationConfig(options)
	const notifications = yield* createNotificationRunner(notificationConfig)
	const githubConfig = yield* normalizeGitHubPluginConfig(options)
	const githubCloneRuntime = yield* makeGitHubCloneRuntime()
	const lspConfig = yield* decodeLspConfig(options)
	const providerPolicy = yield* normalizeProviderPolicyConfig(options)
	const slackConfig = yield* normalizeSlackConfig(options)
	return {
		notifications,
		githubConfig,
		githubCloneRuntime,
		lspConfig,
		providerPolicy,
		slackConfig,
	}
})

export function limitlessTools(
	executeTool: ToolExecutor,
	githubConfig: Parameters<typeof githubTools>[1],
	githubCloneRuntime: Parameters<typeof githubTools>[2],
	slackRunner?: SlackRunner,
) {
	return {
		...artifactTools(executeTool),
		...astGrepTools(executeTool),
		...diagnosticsTools(executeTool),
		...lspTools(executeTool),
		...githubTools(executeTool, githubConfig, githubCloneRuntime),
		...(slackRunner === undefined ? {} : slackTools(executeTool, slackRunner)),
	}
}

export function registerLimitlessTools(
	draft: Pick<ToolDraft, 'add'>,
	tools: ReturnType<typeof limitlessTools>,
): void {
	draft.add(tools.artifact_create)
	draft.add(tools.artifact_list)
	draft.add(tools.artifact_templates_list)
	draft.add(tools.artifact_template_read)
	draft.add(tools.typst_compile)
	draft.add(tools.ast_grep_search)
	draft.add(tools.ast_grep_replace)
	draft.add(tools.lsp_diagnostics)
	draft.add(tools.lsp_definition)
	draft.add(tools.lsp_hover)
	draft.add(tools.lsp_implementation)
	draft.add(tools.lsp_call_hierarchy)
	draft.add(tools.lsp_references)
	draft.add(tools.lsp_symbols)
	draft.add(tools.lsp_rename)
	draft.add(tools.github_clone)
	if ('slack_attach_file' in tools) draft.add(tools.slack_attach_file)
	if ('slack_status' in tools) draft.add(tools.slack_status)
}

export function makeSessionDirectoryResolver(
	session: Pick<Plugin.Context['session'], 'get'>,
): SessionDirectoryResolver {
	return (sessionID) =>
		session.get({ sessionID }).pipe(
			Effect.map((info) => info.location.directory),
			Effect.mapError(
				() =>
					new Tool.Error({
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
		const slackRunner = yield* createSlackRunner(configs.slackConfig, { session: ctx.session })
		const runPromise = Effect.runPromiseWith(yield* Effect.context<Scope.Scope>())
		const tools = limitlessTools(
			executeTool,
			configs.githubConfig,
			configs.githubCloneRuntime,
			slackRunner,
		)

		yield* ctx.tool.transform((draft) => {
			registerLimitlessTools(draft, tools)
		})
		yield* ctx.catalog.transform((catalog) => {
			applyProviderPolicy(catalog, configs.providerPolicy)
		})

		const lookupNotificationSession = (sessionID: string) =>
			Schema.decodeUnknownEffect(Session.ID)(sessionID).pipe(
				Effect.flatMap((decodedSessionID) => ctx.session.get({ sessionID: decodedSessionID })),
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
				slackRunner
					.handleOpenCodeEvent(event)
					.pipe(
						Effect.catchCause((cause) =>
							Effect.logError('[limitless] OpenCode Slack event handler failed', cause),
						),
					),
			),
			Effect.catchCause((cause) =>
				Effect.logError('[limitless] OpenCode Slack event stream stopped', cause),
			),
			Effect.forkScoped({ startImmediately: true }),
		)
		yield* ctx.event.subscribe().pipe(
			Stream.runForEach((event) =>
				configs.notifications
					.handleEvent(event, lookupNotificationSession)
					.pipe(
						Effect.catchCause((cause) =>
							Effect.logError('[limitless] OpenCode notification event handler failed', cause),
						),
					),
			),
			Effect.catchCause((cause) =>
				Effect.logError('[limitless] OpenCode notification event stream stopped', cause),
			),
			Effect.forkScoped({ startImmediately: true }),
		)
		yield* Effect.acquireRelease(
			slackRunner
				.start((input) => runPromise(slackRunner.handleMention(input)))
				.pipe(
					Effect.tapError((error) =>
						Effect.logError(`[limitless] Slack startup failed: ${error.message}`),
					),
					Effect.orDie,
				),
			() => slackRunner.stop,
		)
	}),
})
