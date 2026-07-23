import { Context } from 'effect'

export type ToolExecutionContext = {
	readonly projectRoot: string
	readonly sessionId: string
	readonly agent: string
}

export const ToolExecutionContext = Context.Service<ToolExecutionContext>(
	'@limitless/core/ToolExecutionContext',
)
