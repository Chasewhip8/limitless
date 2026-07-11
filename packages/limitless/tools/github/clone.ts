import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ToolContext } from '@opencode-ai/plugin'
import { Effect } from 'effect'
import { MANAGED_REPOS_STORAGE_RELATIVE_PATH } from '../../core/storage'
import { optionalField } from '../../lib/type-utils'
import {
	assertClean,
	ensureManagedRoot,
	expectedRemote,
	makeDirectory,
	movePath,
	pathState,
	removeTree,
	validateCheckout,
} from './checkout'
import {
	GitHubCloneFailureResult,
	type GitHubCloneInput,
	type GitHubCloneOptions,
	type GitHubCloneState,
	GitHubCloneSuccess,
} from './clone-schema'
import { assertConfiguredRepo, type GitHubConfig } from './config'
import { cloneFailure } from './errors'
import { checkoutSnapshot, fetchSnapshot, git } from './git'
import { cloneDirectoryNameFromValidated, validateGitHubRef } from './repository'
import { type GitHubCloneRuntime, type GitRuntime, makeGitRuntime } from './runtime'
import type { GitHubIncompleteSubmodules, GitHubSubmodule } from './schema'
import { initializeSubmodules, withSubmoduleProgress } from './submodules'

const createCheckout = Effect.fn('createCheckout')(function* (
	runtime: GitRuntime,
	config: GitHubConfig,
	root: string,
	target: string,
	repo: string,
	requestedRef: string | undefined,
	entries: Array<GitHubSubmodule>,
) {
	const stagingId = yield* Effect.try({
		try: randomUUID,
		catch: () =>
			cloneFailure('GITHUB_CLONE_FAILED', 'Failed to allocate managed repository staging path'),
	})
	const staging = path.join(root, `${path.basename(target)}.staging-${stagingId}`)
	return yield* Effect.acquireUseRelease(
		makeDirectory(staging).pipe(Effect.as(staging)),
		() =>
			Effect.gen(function* () {
				yield* git(runtime, staging, 'repository initialization', ['init', '--quiet'])
				yield* git(runtime, staging, 'origin configuration', [
					'remote',
					'add',
					'origin',
					expectedRemote(repo),
				])
				const commit = yield* fetchSnapshot(runtime, staging, requestedRef)
				yield* checkoutSnapshot(runtime, staging, commit)
				yield* withSubmoduleProgress(
					entries,
					initializeSubmodules(
						runtime,
						config,
						staging,
						repo,
						entries,
						new Set([`${repo}@${commit}`]),
					),
				)
				if ((yield* pathState(target)) !== 'missing') {
					return yield* cloneFailure(
						'TARGET_COLLISION',
						'Managed checkout target appeared during creation.',
					)
				}
				yield* movePath(staging, target)
				return commit
			}),
		() => removeTree(staging),
	)
})

const updateCheckout = Effect.fn('updateCheckout')(function* (
	runtime: GitRuntime,
	config: GitHubConfig,
	target: string,
	repo: string,
	requestedRef: string | undefined,
	entries: Array<GitHubSubmodule>,
) {
	yield* validateCheckout(runtime, target, expectedRemote(repo))
	yield* assertClean(runtime, target)
	const commit = yield* fetchSnapshot(runtime, target, requestedRef)
	yield* assertClean(runtime, target)
	yield* checkoutSnapshot(runtime, target, commit)
	yield* withSubmoduleProgress(
		entries,
		initializeSubmodules(runtime, config, target, repo, entries, new Set([`${repo}@${commit}`])),
	)
	return commit
})

const githubCloneRequest = Effect.fn('githubCloneRequest')(function* (
	config: GitHubConfig,
	normalizedRepo: string,
	requestedRef: string | undefined,
	context: ToolContext,
	cloneRuntime: GitHubCloneRuntime,
	options: GitHubCloneOptions,
) {
	const root = yield* ensureManagedRoot(context.worktree)
	const directory = cloneDirectoryNameFromValidated(normalizedRepo, requestedRef)
	const target = path.join(root, directory)
	const runtime = yield* makeGitRuntime(config, context, options)
	return yield* cloneRuntime.targetSemaphore.withPermit(target)(
		Effect.gen(function* () {
			if (runtime.signal.aborted) return yield* cloneFailure('ABORTED', 'GitHub clone was aborted.')
			const entries: Array<GitHubSubmodule> = []
			const existing = yield* pathState(target)
			const state: GitHubCloneState = existing === 'missing' ? 'created' : 'updated'
			const resolvedCommit =
				existing === 'missing'
					? yield* createCheckout(
							runtime,
							config,
							root,
							target,
							normalizedRepo,
							requestedRef,
							entries,
						)
					: yield* updateCheckout(runtime, config, target, normalizedRepo, requestedRef, entries)
			const relativePath = path.posix.join(MANAGED_REPOS_STORAGE_RELATIVE_PATH, directory)
			return GitHubCloneSuccess.make({
				ok: true,
				repo: normalizedRepo,
				relativePath,
				absolutePath: target,
				...optionalField('requestedRef', requestedRef),
				resolvedCommit,
				state,
				lfsObjectsMaterialized: false,
				submodules: { complete: true, entries },
			})
		}),
	)
})

export const githubClone = Effect.fn('githubClone')(function* (
	config: GitHubConfig,
	input: GitHubCloneInput,
	context: ToolContext,
	cloneRuntime: GitHubCloneRuntime,
	options: GitHubCloneOptions = {},
) {
	let repo: string | undefined
	let requestedRef: string | undefined
	return yield* Effect.gen(function* () {
		repo = yield* assertConfiguredRepo(input.repo, config)
		requestedRef = yield* validateGitHubRef(input.ref)
		return yield* githubCloneRequest(config, repo, requestedRef, context, cloneRuntime, options)
	}).pipe(
		Effect.match({
			onFailure: (failure) =>
				GitHubCloneFailureResult.make({
					ok: false,
					...optionalField('repo', repo),
					...optionalField('requestedRef', requestedRef),
					error: { code: failure.code, message: failure.message },
					...(failure.submodules === undefined
						? {}
						: { submodules: failure.submodules satisfies GitHubIncompleteSubmodules }),
				}),
			onSuccess: (result) => result,
		}),
	)
})
