import { Effect, Schema } from 'effect'
import { TrimmedString } from '../../core/command'
import { schemaErrorMessage } from '../../lib/guards'
import { optionalField } from '../../lib/type-utils'
import { cloneFailure } from './errors'
import { assertAllowedRepo, normalizeRepo, trimmed } from './repository'
import { GitHubRepository } from './schema'

export const DEFAULT_GITHUB_TOKEN_ENV = 'GITHUB_TOKEN'

export const GitHubOptionsBlock = Schema.Struct({
	enable: Schema.optional(Schema.Boolean),
	tokenEnv: Schema.optional(TrimmedString),
	tokenFile: Schema.optional(TrimmedString),
	allowedRepos: Schema.optional(Schema.Array(GitHubRepository)),
	allowUnrestrictedRepos: Schema.optional(Schema.Boolean),
})
export const GitHubPluginOptions = Schema.Struct({ github: Schema.optional(GitHubOptionsBlock) })
export const GitHubConfig = Schema.Struct({
	tokenEnv: Schema.String,
	tokenFile: Schema.optional(Schema.String),
	allowedRepos: Schema.Array(GitHubRepository),
	allowUnrestrictedRepos: Schema.Boolean,
})
export type GitHubConfig = typeof GitHubConfig.Type
export const GitHubPluginConfigSchema = Schema.Struct({
	enabled: Schema.Boolean,
	config: GitHubConfig,
})
export class GitHubConfigError extends Schema.TaggedErrorClass<GitHubConfigError>()(
	'GitHubConfigError',
	{ message: Schema.String },
) {}

export const DISABLED_GITHUB_CONFIG = GitHubPluginConfigSchema.make({
	enabled: false,
	config: GitHubConfig.make({
		tokenEnv: DEFAULT_GITHUB_TOKEN_ENV,
		allowedRepos: [],
		allowUnrestrictedRepos: false,
	}),
})

export const normalizeGitHubPluginConfig = Effect.fn('normalizeGitHubPluginConfig')(function* (
	options: unknown,
) {
	if (options === undefined) return DISABLED_GITHUB_CONFIG
	const decoded = yield* Schema.decodeUnknownEffect(GitHubPluginOptions)(options).pipe(
		Effect.mapError((error) => new GitHubConfigError({ message: schemaErrorMessage(error) })),
	)
	if (decoded.github === undefined) return DISABLED_GITHUB_CONFIG
	const github = decoded.github
	const allowedRepos = yield* Effect.forEach(github.allowedRepos ?? [], normalizeRepo).pipe(
		Effect.mapError((error) => new GitHubConfigError({ message: error.message })),
	)
	return GitHubPluginConfigSchema.make({
		enabled: github.enable === true,
		config: GitHubConfig.make({
			tokenEnv: trimmed(github.tokenEnv) ?? DEFAULT_GITHUB_TOKEN_ENV,
			...optionalField('tokenFile', trimmed(github.tokenFile)),
			allowedRepos: [...new Set(allowedRepos)],
			allowUnrestrictedRepos: github.allowUnrestrictedRepos ?? false,
		}),
	})
})

export type GitHubPluginConfig = typeof GitHubPluginConfigSchema.Type
export const GitHubPluginConfig = GitHubPluginConfigSchema

export const assertConfiguredRepo = Effect.fn('assertConfiguredRepo')(function* (
	repo: string,
	config: GitHubConfig,
) {
	if (config.allowedRepos.length === 0 && !config.allowUnrestrictedRepos) {
		return yield* cloneFailure(
			'REPOSITORY_NOT_ALLOWED',
			'GitHub allowedRepos must be non-empty unless allowUnrestrictedRepos is explicitly enabled.',
		)
	}
	return yield* assertAllowedRepo(repo, config.allowedRepos)
})
