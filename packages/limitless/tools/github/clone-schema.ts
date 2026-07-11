import { Schema } from 'effect'
import {
	GitCommitSha,
	GitHubCloneFailureCode,
	GitHubCompleteSubmodules,
	GitHubIncompleteSubmodules,
	GitHubPositiveTimeout,
	GitHubRef,
	GitHubRepository,
} from './schema'

export const GitConfigEntry = Schema.Struct({ key: Schema.String, value: Schema.String })
export type GitConfigEntry = typeof GitConfigEntry.Type

export const GitHubCloneOptions = Schema.Struct({
	gitBin: Schema.optional(Schema.String),
	timeoutMs: Schema.optional(GitHubPositiveTimeout),
	gitConfig: Schema.optional(Schema.Array(GitConfigEntry)),
})
export type GitHubCloneOptions = typeof GitHubCloneOptions.Type

export const GitHubCloneState = Schema.Union([Schema.Literal('created'), Schema.Literal('updated')])
export type GitHubCloneState = typeof GitHubCloneState.Type

export const GitHubCloneInput = Schema.Struct({
	repo: GitHubRepository,
	ref: Schema.optional(GitHubRef),
})
export type GitHubCloneInput = typeof GitHubCloneInput.Type

const GitHubCloneErrorPayload = Schema.Struct({
	code: GitHubCloneFailureCode,
	message: Schema.String,
})
export const GitHubCloneSuccess = Schema.Struct({
	ok: Schema.Literal(true),
	repo: GitHubRepository,
	relativePath: Schema.String,
	absolutePath: Schema.String,
	requestedRef: Schema.optional(GitHubRef),
	resolvedCommit: GitCommitSha,
	state: GitHubCloneState,
	lfsObjectsMaterialized: Schema.Literal(false),
	submodules: GitHubCompleteSubmodules,
})
export const GitHubCloneFailureResult = Schema.Struct({
	ok: Schema.Literal(false),
	repo: Schema.optional(GitHubRepository),
	requestedRef: Schema.optional(GitHubRef),
	error: GitHubCloneErrorPayload,
	submodules: Schema.optional(GitHubIncompleteSubmodules),
})
export const GitHubCloneResult = Schema.Union([GitHubCloneSuccess, GitHubCloneFailureResult])
export type GitHubCloneResult = typeof GitHubCloneResult.Type
