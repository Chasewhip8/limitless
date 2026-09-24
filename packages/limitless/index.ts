import { Plugin } from '@opencode/plugin/effect'
import type { ToolEditor } from '@opencode/plugin/effect/tool'
import { Tool } from '@opencode/schema/tool'
import { Effect } from 'effect'
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

export const resolveGitHubConfig = normalizeGitHubPluginConfig

export const resolvePluginConfigs = Effect.fn('resolvePluginConfigs')(function* (options: unknown) {
	const githubConfig = yield* normalizeGitHubPluginConfig(options)
	const githubCloneRuntime = yield* makeGitHubCloneRuntime()
	const lspConfig = yield* decodeLspConfig(options)
	const providerPolicy = yield* normalizeProviderPolicyConfig(options)
	return {
		githubConfig,
		githubCloneRuntime,
		lspConfig,
		providerPolicy,
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
	draft: Pick<ToolEditor, 'add'>,
	tools: ReturnType<typeof limitlessTools>,
): void {
	draft.add(tools.artifact_create)
	draft.add(tools.artifact_list)
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
		const tools = limitlessTools(executeTool, configs.githubConfig, configs.githubCloneRuntime)

		yield* ctx.tool.transform((draft) => {
			registerLimitlessTools(draft, tools)
		})
		yield* ctx.provider.transform((providers) => {
			applyProviderPolicy(providers, configs.providerPolicy)
		})
	}),
})
