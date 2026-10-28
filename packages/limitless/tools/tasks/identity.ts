import type { Plugin } from '@opencode/plugin/effect'
import { Session } from '@opencode/schema/session'
import { Effect } from 'effect'
import type { ToolExecutionContext } from '../../core/execution'
import { completedUnitPlacement } from '../../plugin/units'
import { taskBoardError } from './errors'

// Callers are identified only from OpenCode's trusted tool context and session
// records, never from model-supplied input. Role permissions hide the tools
// from other agents; these checks hold even where a session grants them.

export const LEAD_AGENT = 'lead'
export const UNIT_AGENT = 'unit'

export type LeadCaller = { readonly sessionID: string }

export type UnitCaller = {
	readonly sessionID: string
	readonly parentID: string
	readonly worktree: string
	readonly directory: string
}

export type SessionView = {
	readonly id: string
	readonly agent: string | undefined
	readonly parentID: string | undefined
	readonly location: { readonly directory: string }
	readonly metadata: Readonly<Record<string, unknown>> | undefined
}

export type ReadSession = (sessionID: string) => Effect.Effect<SessionView, unknown>

export function makeSessionReader(session: Pick<Plugin.Context['session'], 'get'>): ReadSession {
	return (sessionID) =>
		session.get({ sessionID: Session.ID.make(sessionID) }).pipe(
			Effect.map((info) => ({
				id: info.id,
				agent: info.agent,
				parentID: info.parentID ?? undefined,
				location: { directory: info.location.directory },
				metadata: info.metadata,
			})),
		)
}

export const resolveLead = Effect.fn('resolveLead')(function* (caller: ToolExecutionContext) {
	if (caller.agent !== LEAD_AGENT)
		return yield* taskBoardError('ROLE_NOT_ALLOWED', 'Only Lead can manage task board cards.')
	return { sessionID: caller.sessionId } satisfies LeadCaller
})

export const resolveUnit = Effect.fn('resolveUnit')(function* (
	caller: ToolExecutionContext,
	readSession: ReadSession,
) {
	if (caller.agent !== UNIT_AGENT)
		return yield* taskBoardError('ROLE_NOT_ALLOWED', 'Only a Unit can report on a task card.')
	const session = yield* readSession(caller.sessionId).pipe(
		Effect.mapError(() =>
			taskBoardError('SESSION_UNAVAILABLE', 'Could not read the calling Unit session.'),
		),
	)
	if (session.id !== caller.sessionId || session.agent !== UNIT_AGENT)
		return yield* taskBoardError('ROLE_NOT_ALLOWED', 'Only a Unit can report on a task card.')
	const placement = completedUnitPlacement(session)
	if (placement._tag === 'None' || session.parentID === undefined)
		return yield* taskBoardError(
			'UNIT_NOT_PLACED',
			'This session is not a Unit placed in its worktree by a Lead.',
		)
	return {
		sessionID: session.id,
		parentID: session.parentID,
		worktree: placement.value.worktree,
		directory: placement.value.directory,
	} satisfies UnitCaller
})
