import { Schema } from 'effect'
import { GitHubCloneFailureCode, GitHubIncompleteSubmodules } from './schema'

export class CloneFailure extends Schema.TaggedError<CloneFailure>()('CloneFailure', {
	code: GitHubCloneFailureCode,
	message: Schema.String,
	causeCode: Schema.optional(Schema.String),
	submodules: Schema.optional(GitHubIncompleteSubmodules),
}) {}

export function cloneFailure(code: CloneFailure['code'], message: string) {
	return new CloneFailure({ code, message })
}
