import { Agent } from '@opencode-ai/schema/agent'
import { Session } from '@opencode-ai/schema/session'
import { SessionMessage } from '@opencode-ai/schema/session-message'
import { Tool } from '@opencode-ai/schema/tool'
import { Effect, Schema } from 'effect'
import type { ToolExecutionContext } from '../core/execution'
import { makeToolExecutor } from '../plugin/tool-boundary'
import { LspConfig, type LspServerConfig } from '../tools/lsp/config'

export function testToolExecution(
	projectRoot: string,
	sessionId = 'session',
): ToolExecutionContext {
	return {
		projectRoot,
		sessionId,
		agent: 'limitless',
	}
}

export function testToolContext(execution: ToolExecutionContext): Tool.Context {
	return {
		sessionID: Session.ID.make(execution.sessionId),
		agent: Agent.ID.make(execution.agent),
		messageID: SessionMessage.ID.create(),
		id: Schema.decodeUnknownSync(Tool.CallID)('call_test'),
		progress: () => Effect.void,
	}
}

export function testToolExecutor(
	execution: ToolExecutionContext,
	servers: ReadonlyArray<LspServerConfig> = [],
) {
	return makeToolExecutor(() => Effect.succeed(execution.projectRoot), LspConfig.of({ servers }))
}

export function settleTestTool(tool: Tool.Info, input: unknown, execution: ToolExecutionContext) {
	if (!Schema.isSchema(tool.input))
		return Effect.fail(new Tool.Error({ message: 'Test tools must use Effect Schema inputs.' }))
	return tool.execute(Schema.decodeUnknownSync(tool.input)(input), testToolContext(execution))
}
