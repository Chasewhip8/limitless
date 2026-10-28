import { isAbsolute } from 'node:path'
import { Effect, Schema } from 'effect'
import { TrimmedString } from '../../core/command'
import { schemaErrorMessage } from '../../lib/guards'
import { optionalField } from '../../lib/type-utils'
import { TASK_STATUSES, type TaskStatus } from './schema'

export const DEFAULT_LINEAR_TOKEN_ENV = 'LINEAR_API_KEY'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const environmentVariablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u

const LinearId = TrimmedString.check(
	Schema.makeFilter((value) => uuidPattern.test(value) || 'a Linear UUID is required'),
)

const EnabledLinearOptions = Schema.Struct({
	enable: Schema.Literal(true),
	teamId: LinearId,
	projectId: LinearId,
	states: Schema.Struct({
		in_progress: LinearId,
		in_review: LinearId,
		done: LinearId,
		canceled: LinearId,
	}),
	tokenEnv: Schema.optional(
		TrimmedString.check(
			Schema.makeFilter(
				(value) =>
					environmentVariablePattern.test(value) || 'tokenEnv must be an environment variable name',
			),
		),
	),
	tokenFile: Schema.optional(
		TrimmedString.check(
			Schema.makeFilter((value) => isAbsolute(value) || 'tokenFile must be an absolute path'),
		),
	),
})

const LinearBlock = Schema.Struct({ linear: Schema.optional(Schema.Unknown) })
const LinearSwitch = Schema.Struct({ enable: Schema.optional(Schema.Boolean) })

export type TaskBoardConfig = {
	readonly teamId: string
	readonly projectId: string
	readonly states: Readonly<Record<TaskStatus, string>>
	readonly tokenEnv: string
	readonly tokenFile?: string
}

export class TaskBoardConfigError extends Schema.TaggedError<TaskBoardConfigError>()(
	'TaskBoardConfigError',
	{ message: Schema.String },
) {}

const configError = (error: { readonly message: string }) =>
	new TaskBoardConfigError({ message: schemaErrorMessage(error) })

/**
 * Decodes plugin `options.linear`. The board is opt-in: an absent block or
 * `enable: false` disables it without inspecting the remaining fields. Only
 * structure is checked here; credentials and Linear itself are consulted
 * lazily by the tools.
 */
export const decodeTaskBoardConfig = Effect.fn('decodeTaskBoardConfig')(function* (
	options: unknown,
) {
	const block = yield* Schema.decodeUnknownEffect(LinearBlock)(options ?? {}).pipe(
		Effect.mapError(configError),
	)
	const selected = yield* Schema.decodeUnknownEffect(LinearSwitch)(block.linear ?? {}).pipe(
		Effect.mapError(configError),
	)
	if (selected.enable !== true) return undefined
	// Unknown keys are errors: a misspelled tokenFile must not fall back to the
	// environment silently, and inline tokens are unsupported.
	const linear = yield* Schema.decodeUnknownEffect(EnabledLinearOptions)(block.linear, {
		onExcessProperty: 'error',
	}).pipe(Effect.mapError(configError))
	const states = {
		in_progress: linear.states.in_progress.toLowerCase(),
		in_review: linear.states.in_review.toLowerCase(),
		done: linear.states.done.toLowerCase(),
		canceled: linear.states.canceled.toLowerCase(),
	} satisfies Record<TaskStatus, string>
	if (new Set(TASK_STATUSES.map((status) => states[status])).size !== TASK_STATUSES.length)
		return yield* new TaskBoardConfigError({
			message: 'linear.states must map each task status to a distinct workflow state',
		})
	return {
		teamId: linear.teamId.toLowerCase(),
		projectId: linear.projectId.toLowerCase(),
		states,
		tokenEnv: linear.tokenEnv ?? DEFAULT_LINEAR_TOKEN_ENV,
		...optionalField('tokenFile', linear.tokenFile),
	} satisfies TaskBoardConfig
})
