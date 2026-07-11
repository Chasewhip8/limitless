import { Schema, SchemaGetter } from 'effect'
import { TrimmedNonEmptyString } from '../../core/command'

const repositoryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/u
const refPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u
const commitPattern = /^[0-9a-f]{40,64}$/u

const CanonicalGitHubRepository = TrimmedNonEmptyString.pipe(
	Schema.decode({
		decode: SchemaGetter.transform((repo) => repo.toLowerCase()),
		encode: SchemaGetter.transform((repo) => repo.toLowerCase()),
	}),
)

export const GitHubRepository = CanonicalGitHubRepository.check(
	Schema.makeFilter(
		(repo) => repositoryPattern.test(repo) || 'a GitHub owner/repository name is required',
	),
)
export type GitHubRepository = typeof GitHubRepository.Type

export const GitHubRef = TrimmedNonEmptyString.check(
	Schema.makeFilter((ref) => {
		return (
			(ref.length <= 256 &&
				refPattern.test(ref) &&
				!ref.includes('..') &&
				!ref.includes('//') &&
				!ref.includes('@{') &&
				!ref.endsWith('/') &&
				!ref.endsWith('.') &&
				!ref.endsWith('.lock')) ||
			'a safe Git ref is required'
		)
	}),
)
export type GitHubRef = typeof GitHubRef.Type

export const GitCommitSha = Schema.String.check(
	Schema.makeFilter(
		(commit) => commitPattern.test(commit) || 'a lowercase Git commit SHA is required',
	),
)
export type GitCommitSha = typeof GitCommitSha.Type

export const GitHubPositiveTimeout = Schema.Finite.check(Schema.isGreaterThan(0))
export type GitHubPositiveTimeout = typeof GitHubPositiveTimeout.Type

export const GitHubCloneFailureCode = Schema.Union([
	Schema.Literal('REPOSITORY_NOT_ALLOWED'),
	Schema.Literal('INVALID_REF'),
	Schema.Literal('TOKEN_READ_FAILED'),
	Schema.Literal('INVALID_TOKEN'),
	Schema.Literal('ABORTED'),
	Schema.Literal('GIT_COMMAND_FAILED'),
	Schema.Literal('UNSAFE_STORAGE_PATH'),
	Schema.Literal('CHECKOUT_IDENTITY_MISMATCH'),
	Schema.Literal('DIRTY_CHECKOUT'),
	Schema.Literal('REF_RESOLUTION_FAILED'),
	Schema.Literal('SUBMODULE_URL_REJECTED'),
	Schema.Literal('SUBMODULE_PATH_REJECTED'),
	Schema.Literal('SUBMODULE_CONFIG_INVALID'),
	Schema.Literal('SUBMODULE_INIT_FAILED'),
	Schema.Literal('TARGET_COLLISION'),
	Schema.Literal('GITHUB_CLONE_FAILED'),
])
export type GitHubCloneFailureCode = typeof GitHubCloneFailureCode.Type

export const GitHubSubmodule = Schema.Struct({
	path: Schema.String,
	repo: GitHubRepository,
	url: Schema.String,
	commit: GitCommitSha,
	depth: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
})
export type GitHubSubmodule = typeof GitHubSubmodule.Type

export const GitHubIncompleteSubmodules = Schema.Struct({
	complete: Schema.Literal(false),
	entries: Schema.Array(GitHubSubmodule),
	gaps: Schema.Array(Schema.String),
})
export type GitHubIncompleteSubmodules = typeof GitHubIncompleteSubmodules.Type

export const GitHubCompleteSubmodules = Schema.Struct({
	complete: Schema.Literal(true),
	entries: Schema.Array(GitHubSubmodule),
})
export type GitHubCompleteSubmodules = typeof GitHubCompleteSubmodules.Type
