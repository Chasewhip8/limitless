import { NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { expect, test } from 'vitest'
import { PipelineConfig } from '../config'
import { GitHub, githubLayer } from '../github/service'
import { review, settings } from './fixtures'

test('GitHub identity survives canonical URL changes, closed PRs and deleted source forks', async () => {
	const base = { sha: 'a'.repeat(40), repo: { id: 42, full_name: 'new-owner/renamed' } }
	const head = {
		sha: 'b'.repeat(40),
		ref: 'feature',
		repo: { id: 43, full_name: 'contributor/fork' },
	}
	const responses = [
		{ number: 1, state: 'open', base, head },
		{ number: 1, state: 'closed', base, head },
		{ number: 1, state: 'open', base, head: { ...head, repo: null } },
	]
	const client = HttpClient.make((request, url) =>
		Effect.sync(() => {
			expect(url.href).toBe('https://api.github.com/repos/test/repo/pulls/1')
			return HttpClientResponse.fromWeb(request, Response.json(responses.shift()))
		}),
	)
	await Effect.runPromise(
		Effect.gen(function* () {
			const github = yield* GitHub
			const open = yield* github.resolve(review())
			expect(open).toMatchObject({
				key: '42:1',
				url: 'https://github.com/new-owner/renamed/pull/1',
				checkout: {
					repositoryId: 42,
					repository: 'new-owner/renamed',
					sourceRepository: 'contributor/fork',
				},
			})
			for (let index = 0; index < 2; index++) {
				expect(yield* github.resolve(review())).toEqual({
					key: open.key,
					url: open.url,
					checkout: undefined,
				})
			}
		}).pipe(
			Effect.provide(
				githubLayer.pipe(
					Layer.provide(
						Layer.mergeAll(
							NodeServices.layer,
							Layer.succeed(PipelineConfig, settings),
							Layer.succeed(HttpClient.HttpClient, client),
						),
					),
				),
			),
		),
	)
})
