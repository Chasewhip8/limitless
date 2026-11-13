import { Context, Effect, Layer, Schema } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { PipelineConfig, readSecret } from '../config'
import {
	Commit,
	PullRequest,
	pullRequestReviewKey,
	Repository,
	type ReviewRequest,
} from '../tasks/schema'
import { PullRequestUnavailable } from './schema'

const GitHubRepository = Schema.Struct({
	id: Schema.Int.check(
		Schema.isGreaterThan(0),
		Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
	),
	full_name: Repository,
})

const GitHubPullRequest = Schema.Struct({
	number: Schema.Int,
	state: Schema.Literals(['open', 'closed']),
	head: Schema.Struct({
		ref: Schema.String,
		sha: Commit,
		repo: Schema.NullOr(GitHubRepository),
	}),
	base: Schema.Struct({ sha: Commit, repo: GitHubRepository }),
})

const make = Effect.gen(function* () {
	const config = yield* PipelineConfig
	const client = yield* HttpClient.HttpClient
	const token =
		config.githubTokenFile === null ? undefined : yield* readSecret(config.githubTokenFile)
	const resolve = Effect.fn('GitHub.resolve')(
		function* (request: ReviewRequest) {
			const url = new URL(request.pr)
			const [, owner, repository, , number] = url.pathname.split('/')
			const endpoint = `https://api.github.com/repos/${owner}/${repository}/pulls/${number}`
			const baseRequest = HttpClientRequest.get(endpoint).pipe(
				HttpClientRequest.setHeader('accept', 'application/vnd.github+json'),
				HttpClientRequest.setHeader('x-github-api-version', '2022-11-28'),
				HttpClientRequest.setHeader('user-agent', 'limitless-pipeline'),
			)
			const authenticated =
				token === undefined ? baseRequest : HttpClientRequest.bearerToken(baseRequest, token)
			const response = yield* client
				.execute(authenticated)
				.pipe(
					Effect.mapError(() => PullRequestUnavailable.make({ message: 'GitHub request failed' })),
				)
			if (response.status !== 200)
				return yield* PullRequestUnavailable.make({
					message: 'GitHub did not return an accessible pull request',
				})
			const pr = yield* HttpClientResponse.schemaBodyJson(GitHubPullRequest)(response).pipe(
				Effect.mapError(() =>
					PullRequestUnavailable.make({ message: 'GitHub returned an unsupported pull request' }),
				),
			)
			const identity = {
				key: pullRequestReviewKey(pr.base.repo.id, pr.number),
				url: `https://github.com/${pr.base.repo.full_name}/pull/${pr.number}`,
			}
			if (pr.state !== 'open' || pr.head.repo === null) return { ...identity, checkout: undefined }
			const checkout = PullRequest.make({
				url: identity.url,
				repository: pr.base.repo.full_name,
				sourceRepository: pr.head.repo.full_name,
				repositoryId: pr.base.repo.id,
				sourceRepositoryId: pr.head.repo.id,
				number: pr.number,
				headRef: pr.head.ref,
				headSha: pr.head.sha,
				baseSha: pr.base.sha,
			})
			return { ...identity, checkout }
		},
		Effect.timeout('20 seconds'),
		Effect.catchTag('TimeoutError', () =>
			PullRequestUnavailable.make({ message: 'GitHub request timed out' }),
		),
	)
	return { resolve }
})

export class GitHub extends Context.Service<GitHub, Effect.Success<typeof make>>()(
	'pipeline/github/GitHub',
) {}
export const githubLayer = Layer.effect(GitHub, make)
