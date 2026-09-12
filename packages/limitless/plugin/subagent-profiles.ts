import type { SessionContext, SessionDomain } from '@opencode/plugin/effect/session'
import type { Session } from '@opencode/schema/session'
import { Effect, Schema } from 'effect'
import { TrimmedNonEmptyString } from '../core/command'
import { schemaErrorMessage } from '../lib/guards'

export const DEFAULT_FAST_SUBAGENTS = ['oracle-solve', 'research', 'review', 'worker'] as const

const SubagentProfileOptions = Schema.Struct({
	agents: Schema.optional(
		Schema.Struct({
			fastSubagents: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
		}),
	),
})

export const SubagentProfileConfig = Schema.Struct({
	fastSubagents: Schema.Array(TrimmedNonEmptyString),
})
export type SubagentProfileConfig = typeof SubagentProfileConfig.Type

export class SubagentProfileConfigError extends Schema.TaggedError<SubagentProfileConfigError>()(
	'SubagentProfileConfigError',
	{ message: Schema.String },
) {}

export class SubagentProfileError extends Schema.TaggedError<SubagentProfileError>()(
	'SubagentProfileError',
	{ message: Schema.String },
) {}

export const normalizeSubagentProfileConfig = Effect.fn('normalizeSubagentProfileConfig')(
	function* (options: unknown) {
		const decoded = yield* Schema.decodeUnknownEffect(SubagentProfileOptions)(options ?? {}).pipe(
			Effect.mapError(
				(error) => new SubagentProfileConfigError({ message: schemaErrorMessage(error) }),
			),
		)
		return SubagentProfileConfig.make({
			fastSubagents: [...new Set(decoded.agents?.fastSubagents ?? DEFAULT_FAST_SUBAGENTS)],
		})
	},
)

export type SubagentProfileSessionLookup = (
	sessionID: Session.ID,
) => Effect.Effect<Pick<Session.Info, 'parentID' | 'agent'>, SubagentProfileError>

export function makeSubagentProfileHook(
	config: SubagentProfileConfig,
	lookupSession: SubagentProfileSessionLookup,
) {
	const fastSubagents = new Set(config.fastSubagents)
	return Effect.fn('applySubagentProfile')(function* (event: SessionContext) {
		if (event.model.providerID !== 'openai' || !fastSubagents.has(event.agent)) return

		let session = yield* lookupSession(event.sessionID)
		if (session.parentID === undefined) return

		// Resolve each request so resumed and nested children follow the current root profile.
		const visited = new Set<Session.ID>([event.sessionID])
		while (session.parentID !== undefined) {
			if (visited.has(session.parentID)) {
				return yield* new SubagentProfileError({
					message: `Cannot resolve subagent profile: cycle in ancestry of ${event.sessionID}.`,
				})
			}
			visited.add(session.parentID)
			session = yield* lookupSession(session.parentID)
		}

		if (session.agent === 'limitless') {
			// Explicitly override Fast aliases still selected in existing or customized children.
			event.options.serviceTier = 'default'
		}
		if (session.agent === 'limitless-fast') {
			event.options.serviceTier = 'priority'
		}
	})
}

export const registerSubagentProfileHooks = Effect.fn('registerSubagentProfileHooks')(function* (
	session: Pick<SessionDomain, 'hook'>,
	applyProfile: ReturnType<typeof makeSubagentProfileHook>,
) {
	for (const name of ['context', 'compaction', 'generate'] as const) {
		yield* session.hook(name, (event) => applyProfile(event).pipe(Effect.orDie), {
			providerID: 'openai',
		})
	}
})
