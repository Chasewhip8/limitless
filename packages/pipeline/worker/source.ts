import { PrepareSession } from '@limitless/capsule/rpc'
import { Schema } from 'effect'

export const SourceSpec = PrepareSession.fields.source
export type SourceSpec = typeof SourceSpec.Type

interface PullRequestHead {
	readonly repository: string
	readonly sourceRepository: string
	readonly number: number
	readonly headRef: string
	readonly headSha: string
	readonly baseSha: string
}

/** Clones the fork's head branch, and requires both the pull and branch refs to stay at the head commit. */
export const pullRequestSource = (pr: PullRequestHead) =>
	Schema.decodeUnknownEffect(SourceSpec)({
		repository: pr.sourceRepository,
		ref: pr.headRef,
		branch: pr.headRef,
		commit: pr.headSha,
		upstream: { repository: pr.repository, commits: [pr.baseSha] },
		remoteRefs: [
			{ repository: pr.repository, ref: `refs/pull/${pr.number}/head`, commit: pr.headSha },
			{ repository: pr.sourceRepository, ref: `refs/heads/${pr.headRef}`, commit: pr.headSha },
		],
	})
