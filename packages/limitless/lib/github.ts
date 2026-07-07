import { Schema } from 'effect'

export const GitHubOptionsBlock = Schema.Struct({
	enable: Schema.optional(Schema.Boolean),
	tokenEnv: Schema.optional(Schema.String),
	tokenFile: Schema.optional(Schema.String),
	allowedRepos: Schema.optional(Schema.Array(Schema.String)),
	allowUnrestrictedRepos: Schema.optional(Schema.Boolean),
})
export type GitHubOptionsBlock = typeof GitHubOptionsBlock.Type

export const GitHubConfig = Schema.Struct({
	tokenEnv: Schema.String,
	tokenFile: Schema.optional(Schema.String),
	allowedRepos: Schema.Array(Schema.String),
	allowUnrestrictedRepos: Schema.Boolean,
})
export type GitHubConfig = typeof GitHubConfig.Type

export const GitHubPluginConfig = Schema.Struct({
	enabled: Schema.Boolean,
	config: GitHubConfig,
})
export type GitHubPluginConfig = typeof GitHubPluginConfig.Type

export const GitHubCodeSearchInput = Schema.Struct({
	query: Schema.String,
	repos: Schema.optional(Schema.Array(Schema.String)),
	owner: Schema.optional(Schema.String),
	language: Schema.optional(Schema.String),
	filename: Schema.optional(Schema.String),
	extension: Schema.optional(Schema.String),
	maxResults: Schema.optional(Schema.Finite),
})
export type GitHubCodeSearchInput = typeof GitHubCodeSearchInput.Type

export const GitHubFileReadInput = Schema.Struct({
	repo: Schema.String,
	path: Schema.String,
	ref: Schema.optional(Schema.String),
	maxBytes: Schema.optional(Schema.Finite),
})
export type GitHubFileReadInput = typeof GitHubFileReadInput.Type

export const GitHubRepoTreeInput = Schema.Struct({
	repo: Schema.String,
	ref: Schema.optional(Schema.String),
	pathPrefix: Schema.optional(Schema.String),
	recursive: Schema.optional(Schema.Boolean),
	maxEntries: Schema.optional(Schema.Finite),
})
export type GitHubRepoTreeInput = typeof GitHubRepoTreeInput.Type

export type RateLimitInfo = {
	readonly limit?: number
	readonly remaining?: number
	readonly reset?: number
	readonly retryAfter?: number
}

export type GitHubCodeSearchResult = {
	readonly ok: boolean
	readonly results: ReadonlyArray<{
		readonly repo: string
		readonly path: string
		readonly sha?: string
		readonly htmlUrl?: string
		readonly score?: number
		readonly textMatches?: ReadonlyArray<{
			readonly fragment: string
			readonly matches?: ReadonlyArray<unknown>
		}>
	}>
	readonly rateLimit?: RateLimitInfo
	readonly gaps?: ReadonlyArray<string>
}

export type GitHubFileReadResult = {
	readonly ok: boolean
	readonly repo: string
	readonly path: string
	readonly ref?: string
	readonly sha?: string
	readonly content?: string
	readonly encoding?: string
	readonly htmlUrl?: string
	readonly size?: number
	readonly rateLimit?: RateLimitInfo
	readonly gaps?: ReadonlyArray<string>
}

export type GitHubRepoTreeResult = {
	readonly ok: boolean
	readonly repo: string
	readonly ref?: string
	readonly entries: ReadonlyArray<{
		readonly path: string
		readonly type: 'file' | 'dir' | 'symlink' | 'submodule' | 'unknown'
		readonly sha?: string
		readonly size?: number
	}>
	readonly recursive?: boolean
	readonly truncated?: boolean
	readonly rateLimit?: RateLimitInfo
	readonly gaps?: ReadonlyArray<string>
}
