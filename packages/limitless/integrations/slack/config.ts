import type { PluginOptions } from '@opencode-ai/plugin'
import { Effect, Schema } from 'effect'
import { schemaErrorMessage } from '../../lib/guards'

const EnvironmentVariableName = Schema.String.check(
	Schema.makeFilter((value) =>
		/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) ? true : 'must be an environment variable name',
	),
)

export const SlackOptionsBlock = Schema.Struct({
	enable: Schema.optional(Schema.Boolean),
	enabled: Schema.optional(Schema.Boolean),
	repository: Schema.optional(Schema.String),
	agent: Schema.optional(Schema.NonEmptyString),
	botTokenEnv: Schema.optional(EnvironmentVariableName),
	appTokenEnv: Schema.optional(EnvironmentVariableName),
})

export const SlackPluginOptions = Schema.Struct({
	slack: Schema.optional(SlackOptionsBlock),
})

const SlackConfigFields = Schema.Struct({
	enabled: Schema.Boolean,
	repository: Schema.NullOr(Schema.String),
	agent: Schema.NonEmptyString,
	botTokenEnv: EnvironmentVariableName,
	appTokenEnv: EnvironmentVariableName,
})

export const SlackConfig = SlackConfigFields.check(
	Schema.makeFilter<typeof SlackConfigFields.Type>((config) => {
		if (!config.enabled) return true
		if (config.repository === null || config.repository.trim().length === 0)
			return 'an enabled Slack configuration requires a repository'
		if (!config.repository.startsWith('/')) return 'the Slack repository must be an absolute path'
		return true
	}),
)
export type SlackConfig = typeof SlackConfig.Type

export class SlackConfigError extends Schema.TaggedErrorClass<SlackConfigError>()(
	'SlackConfigError',
	{ message: Schema.String },
) {}

export const DEFAULT_SLACK_AGENT = 'gary'
export const DEFAULT_SLACK_BOT_TOKEN_ENV = 'SLACK_BOT_TOKEN'
export const DEFAULT_SLACK_APP_TOKEN_ENV = 'SLACK_APP_TOKEN'
export const SLACK_SERVICE_ACTIVATION_ENV = 'LIMITLESS_SLACK_SERVICE'
export const MAX_SLACK_IMAGES_PER_TURN = 4
export const MAX_SLACK_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_SLACK_MARKDOWN_CHARS = 12_000
export const MAX_SLACK_STATUS_CHARS = 1_000

export const DISABLED_SLACK_CONFIG = SlackConfig.make({
	enabled: false,
	repository: null,
	agent: DEFAULT_SLACK_AGENT,
	botTokenEnv: DEFAULT_SLACK_BOT_TOKEN_ENV,
	appTokenEnv: DEFAULT_SLACK_APP_TOKEN_ENV,
})

export const normalizeSlackConfig = Effect.fn('normalizeSlackConfig')(function* (
	options: PluginOptions | undefined,
) {
	if (options === undefined) return DISABLED_SLACK_CONFIG
	const decoded = yield* Schema.decodeUnknownEffect(SlackPluginOptions)(options).pipe(
		Effect.mapError((error) => new SlackConfigError({ message: schemaErrorMessage(error) })),
	)
	if (decoded.slack === undefined) return DISABLED_SLACK_CONFIG
	const slack = decoded.slack
	return yield* Schema.decodeUnknownEffect(SlackConfig)({
		enabled: slack.enable ?? slack.enabled ?? false,
		repository: slack.repository?.trim() ?? null,
		agent: slack.agent ?? DEFAULT_SLACK_AGENT,
		botTokenEnv: slack.botTokenEnv ?? DEFAULT_SLACK_BOT_TOKEN_ENV,
		appTokenEnv: slack.appTokenEnv ?? DEFAULT_SLACK_APP_TOKEN_ENV,
	}).pipe(Effect.mapError((error) => new SlackConfigError({ message: schemaErrorMessage(error) })))
})
