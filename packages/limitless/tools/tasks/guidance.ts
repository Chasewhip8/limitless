import type { Plugin } from '@opencode/plugin/effect'
import type { SessionContext } from '@opencode/plugin/effect/session'
import { Effect } from 'effect'
import { LEAD_AGENT, UNIT_AGENT } from './identity'

export const LEAD_TASK_BOARD_GUIDANCE = `## Linear task board

The \`task_*\` tools mirror Unit assignments on a shared Linear board. Native \`subagent\` dispatch, follow-ups, and returns still carry the work; the board is advisory.

- Before dispatching an approved assignment to a new Unit, call \`task_create\` with a short title and the assignment summary. Put the returned \`taskId\` in the brief and ask the Unit to report on it with \`task_report\` before its final response.
- Send corrections to the same Unit and card: call \`task_review\` with \`decision: "continue"\` and a short note, then continue the Unit's session.
- After reviewing returned work, call \`task_review\` with \`"accept"\`, or with \`"cancel"\` when the assignment is abandoned.
- Use \`task_list\` to see your cards, their status, and the latest Unit reports, for example after a restart or a missed return.
- If a task tool fails, mention it and continue natively; never hold dispatch or review on the board. When a write's outcome is unknown, check \`task_list\` before retrying it.`

export const UNIT_TASK_BOARD_GUIDANCE = `## Linear task board

When your brief includes a task board \`taskId\`, report on that card with \`task_report\` before your final response:

- \`result: "ready"\` only once the brief is implemented, validated, and reviewed, including any internal review you started.
- \`result: "blocked"\` when you need a decision from the Lead; ask the question in your final response as well.

Do not report while an internal review is still pending. The report does not replace your final response, which still returns to the Lead natively. If \`task_report\` fails, mention the failure in your final response and finish normally.`

/** Guidance for a request whose agent can actually use its role's task tools. */
export function taskBoardGuidance(
	request: Pick<SessionContext, 'agent' | 'tools'>,
): string | undefined {
	if (request.agent === LEAD_AGENT && 'task_create' in request.tools)
		return LEAD_TASK_BOARD_GUIDANCE
	if (request.agent === UNIT_AGENT && 'task_report' in request.tools)
		return UNIT_TASK_BOARD_GUIDANCE
	return undefined
}

export const registerTaskBoardGuidance = Effect.fn('registerTaskBoardGuidance')(function* (
	ctx: Pick<Plugin.Context, 'session'>,
) {
	yield* ctx.session.hook('context', (request) =>
		Effect.sync(() => {
			const guidance = taskBoardGuidance(request)
			if (guidance !== undefined) request.system.push({ type: 'text', text: guidance })
		}),
	)
})
