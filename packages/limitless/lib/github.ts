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

export const GitHubCloneInput = Schema.Struct({
	repo: Schema.String,
	ref: Schema.optional(Schema.String),
})
export type GitHubCloneInput = typeof GitHubCloneInput.Type

export type GitHubSubmodule = {
	readonly path: string
	readonly repo: string
	readonly url: string
	readonly commit: string
	readonly depth: number
}

export type GitHubCloneResult =
	| {
			readonly ok: true
			readonly repo: string
			readonly relativePath: string
			readonly absolutePath: string
			readonly requestedRef?: string
			readonly resolvedCommit: string
			readonly state: 'created' | 'updated'
			readonly lfsObjectsMaterialized: false
			readonly submodules: {
				readonly complete: true
				readonly entries: ReadonlyArray<GitHubSubmodule>
			}
	  }
	| {
			readonly ok: false
			readonly repo?: string
			readonly requestedRef?: string
			readonly error: {
				readonly code: string
				readonly message: string
			}
			readonly submodules?: {
				readonly complete: false
				readonly entries: ReadonlyArray<GitHubSubmodule>
				readonly gaps: ReadonlyArray<string>
			}
	  }
