import type { Plugin } from '@opencode/plugin/effect'
import type { SessionContext } from '@opencode/plugin/effect/session'
import { Effect } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { makePipelineClient } from './client'
import { type PipelineConfig, readPipelineToken } from './config'
import { makeReceipts, recoveryRequest } from './receipts'
import { pipelineMutationTools, pipelineTools } from './tools'

export { normalizePipelinePluginConfig } from './config'

export const restorePipelineContext = Effect.fn('Pipeline.restoreContext')(function* (
	receipts: Effect.Success<ReturnType<typeof makeReceipts>>,
	event: Pick<SessionContext, 'sessionID' | 'agent' | 'system' | 'tools'>,
) {
	if (event.agent !== 'limitless') {
		for (const name of pipelineMutationTools) delete event.tools[name]
		return
	}
	const current = yield* receipts.list(event.sessionID)
	if (current.length === 0) return
	const contextReceipts = current.map((receipt) => {
		if (receipt._tag === 'Prepared') {
			return { _tag: receipt._tag, operation: receipt.operation, recover: recoveryRequest(receipt) }
		}
		return {
			_tag: receipt._tag,
			operation: receipt.operation,
			taskId: receipt.taskId,
			commandId: receipt.commandId,
			pr: receipt.pr,
			...(receipt.afterTaskId === undefined ? {} : { afterTaskId: receipt.afterTaskId }),
			...(receipt.afterCommandId === undefined ? {} : { afterCommandId: receipt.afterCommandId }),
		}
	})
	event.system.push({
		type: 'text',
		text: `Durable Pipeline dispatch receipts for this session. Prepared receipts may already be accepted by Athena: recover them by repeating their exact recover request, never a changed one. Accepted receipts identify dispatch intent, not an execution result or verdict. Unconfirmed native delivery blocks automatic followups and never means the command did not start. Native OpenCode owns prompts, execution, history and outputs; Idle and interruption acknowledgements do not prove all OS writers stopped.\n${JSON.stringify(contextReceipts)}`,
	})
})

export const registerPipeline = Effect.fn('Pipeline.register')(function* (
	ctx: Plugin.Context,
	config: PipelineConfig,
) {
	if (!config.enabled) return
	const token = yield* readPipelineToken(config.tokenFile)
	const receipts = yield* makeReceipts(ctx.storage, config.url)
	const client = yield* makePipelineClient({ url: config.url, token }, receipts).pipe(
		Effect.provide(FetchHttpClient.layer),
	)
	const tools = pipelineTools(client)
	yield* ctx.tool.transform((draft) => {
		draft.add(tools.pipeline_review)
		draft.add(tools.pipeline_resume)
		draft.add(tools.pipeline_wait)
		draft.add(tools.pipeline_interrupt)
		draft.add(tools.pipeline_close)
	})
	yield* ctx.session.hook('context', (event) =>
		restorePipelineContext(receipts, event).pipe(Effect.orDie),
	)
})
