import type { Plugin } from '@opencode/plugin/effect'
import type { SessionContext } from '@opencode/plugin/effect/session'
import { Effect } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { makePipelineClient } from './client'
import { type PipelineConfig, readPipelineToken } from './config'
import { pipelineMutationTools, pipelineTools } from './tools'

export { normalizePipelinePluginConfig } from './config'

export function hidePipelineMutations(event: Pick<SessionContext, 'agent' | 'tools'>) {
	if (event.agent === 'limitless') return
	for (const name of pipelineMutationTools) delete event.tools[name]
}

export const registerPipeline = Effect.fn('Pipeline.register')(function* (
	ctx: Plugin.Context,
	config: PipelineConfig,
) {
	if (!config.enabled) return
	const token = yield* readPipelineToken(config.tokenFile)
	const client = yield* makePipelineClient({ url: config.url, token }).pipe(
		Effect.provide(FetchHttpClient.layer),
	)
	const tools = pipelineTools(client)
	yield* ctx.tool.transform((draft) => {
		draft.add(tools.pipeline_review)
		draft.add(tools.pipeline_continue)
		draft.add(tools.pipeline_restart)
		draft.add(tools.pipeline_wait)
		draft.add(tools.pipeline_interrupt)
	})
	yield* ctx.session.hook('context', (event) => Effect.sync(() => hidePipelineMutations(event)))
})
