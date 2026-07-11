import path from 'node:path'
import { Effect } from 'effect'
import { pathIsInside } from '../../core/paths'
import { canonicalPath, pathState, validateCheckout } from './checkout'
import { assertConfiguredRepo, type GitHubConfig } from './config'
import { CloneFailure, cloneFailure } from './errors'
import { decodeCommit, git, runGit } from './git'
import { cleanRemoteUrl, normalizeRepo, trimmed } from './repository'
import type { GitRuntime } from './runtime'
import { GitHubSubmodule } from './schema'

const MAX_SUBMODULE_DEPTH = 32

const repoFromGitHubPath = Effect.fn('repoFromGitHubPath')(function* (pathname: string) {
	const decoded = yield* Effect.try({
		try: () => decodeURIComponent(pathname),
		catch: () => cloneFailure('SUBMODULE_URL_REJECTED', 'Submodule URL contains invalid encoding.'),
	})
	const segments = decoded.replace(/^\/+|\/+$/gu, '').split('/')
	if (segments.length !== 2 || segments[0] === undefined || segments[1] === undefined)
		return yield* cloneFailure(
			'SUBMODULE_URL_REJECTED',
			'Submodule URL is not a GitHub owner/repository path.',
		)
	return yield* normalizeRepo(`${segments[0]}/${segments[1].replace(/\.git$/iu, '')}`).pipe(
		Effect.mapError((error) => cloneFailure('SUBMODULE_URL_REJECTED', error.message)),
	)
})

export const resolveGitHubSubmoduleUrl = Effect.fn('resolveGitHubSubmoduleUrl')(function* (
	rawUrl: string,
	parentRepo: string,
) {
	const value = rawUrl.trim()
	if (value.length === 0 || /[\r\n]/u.test(value))
		return yield* cloneFailure('SUBMODULE_URL_REJECTED', 'Submodule URL is empty or malformed.')
	if (value.startsWith('./') || value.startsWith('../')) {
		const parent = yield* normalizeRepo(parentRepo).pipe(
			Effect.mapError((error) => cloneFailure('SUBMODULE_URL_REJECTED', error.message)),
		)
		return cleanRemoteUrl(
			yield* repoFromGitHubPath(path.posix.normalize(path.posix.join(`/${parent}.git`, value))),
		)
	}
	const scp = /^(?:git@)?github\.com:([^?#]+)$/iu.exec(value)
	if (scp?.[1] !== undefined) return cleanRemoteUrl(yield* repoFromGitHubPath(scp[1]))
	const parsed = yield* Effect.try({
		try: () => new URL(value),
		catch: () =>
			cloneFailure('SUBMODULE_URL_REJECTED', 'Submodule URL is not a supported GitHub URL.'),
	})
	if (
		!['https:', 'ssh:'].includes(parsed.protocol) ||
		parsed.hostname.toLowerCase() !== 'github.com' ||
		parsed.port.length > 0 ||
		parsed.search.length > 0 ||
		parsed.hash.length > 0
	)
		return yield* cloneFailure(
			'SUBMODULE_URL_REJECTED',
			'Submodules must use HTTPS, SSH, scp-style, or relative URLs hosted on github.com.',
		)
	return cleanRemoteUrl(yield* repoFromGitHubPath(parsed.pathname))
})

const submoduleRepo = Effect.fn('submoduleRepo')(function* (cleanUrl: string) {
	const parsed = yield* Effect.try({
		try: () => new URL(cleanUrl),
		catch: () => cloneFailure('SUBMODULE_URL_REJECTED', 'Invalid normalized submodule URL.'),
	})
	return yield* repoFromGitHubPath(parsed.pathname)
})

const assertNoSymlinkPath = Effect.fn('assertNoSymlinkPath')(function* (
	root: string,
	relativePath: string,
) {
	if (
		path.isAbsolute(relativePath) ||
		relativePath.includes('\\') ||
		relativePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
	)
		return yield* cloneFailure('SUBMODULE_PATH_REJECTED', 'Submodule path is not safely contained.')
	const target = path.resolve(root, relativePath)
	if (!pathIsInside(root, target) || target === path.resolve(root))
		return yield* cloneFailure(
			'SUBMODULE_PATH_REJECTED',
			'Submodule path escapes its parent checkout.',
		)
	let current = path.resolve(root)
	for (const segment of relativePath.split('/')) {
		current = path.join(current, segment)
		const state = yield* pathState(current)
		if (state === 'symlink')
			return yield* cloneFailure(
				'SUBMODULE_PATH_REJECTED',
				'Submodule path traverses a symbolic link.',
			)
		if (state === 'missing') break
	}
	return target
})

const gitmoduleKeys = Effect.fn('gitmoduleKeys')(function* (
	runtime: GitRuntime,
	repositoryPath: string,
) {
	if ((yield* pathState(path.join(repositoryPath, '.gitmodules'))) === 'missing') return []
	const result = yield* runGit(
		runtime,
		[
			'config',
			'--null',
			'--file',
			'.gitmodules',
			'--name-only',
			'--get-regexp',
			'^submodule\\..*\\.path$',
		],
		repositoryPath,
	)
	if (!result.ok && result.exitCode === 1 && result.stdout.trim().length === 0) return []
	if (!result.ok)
		return yield* cloneFailure(
			'SUBMODULE_CONFIG_INVALID',
			`Git submodule declaration inspection failed: ${trimmed(result.stderr) ?? 'Git exited without output.'}`,
		)
	return result.stdout.split('\0').filter((key) => key.length > 0)
})

export function initializeSubmodules(
	runtime: GitRuntime,
	config: GitHubConfig,
	repositoryPath: string,
	repositoryRepo: string,
	entries: Array<GitHubSubmodule>,
	ancestorCommits: ReadonlySet<string>,
	depth = 1,
	prefix = '',
): Effect.Effect<void, CloneFailure> {
	return Effect.suspend(() =>
		Effect.gen(function* () {
			if (depth > MAX_SUBMODULE_DEPTH)
				return yield* cloneFailure(
					'SUBMODULE_INIT_FAILED',
					`Submodule nesting exceeds ${MAX_SUBMODULE_DEPTH}.`,
				)
			for (const key of yield* gitmoduleKeys(runtime, repositoryPath)) {
				const match = /^submodule\.(.+)\.path$/u.exec(key)
				if (match?.[1] === undefined)
					return yield* cloneFailure(
						'SUBMODULE_CONFIG_INVALID',
						'Submodule declaration has an invalid key.',
					)
				const name = match[1]
				const subPath = yield* git(runtime, repositoryPath, 'submodule path inspection', [
					'config',
					'--file',
					'.gitmodules',
					'--get',
					key,
				])
				const rawUrl = yield* git(runtime, repositoryPath, 'submodule URL inspection', [
					'config',
					'--file',
					'.gitmodules',
					'--get',
					`submodule.${name}.url`,
				])
				const submodulePath = yield* assertNoSymlinkPath(repositoryPath, subPath)
				const cleanUrl = yield* resolveGitHubSubmoduleUrl(rawUrl, repositoryRepo)
				const repo = yield* submoduleRepo(cleanUrl).pipe(
					Effect.flatMap((candidate) => assertConfiguredRepo(candidate, config)),
				)
				yield* git(runtime, repositoryPath, 'submodule URL rewrite', [
					'config',
					'--local',
					`submodule.${name}.url`,
					cleanUrl,
				])
				yield* git(runtime, repositoryPath, 'submodule update strategy configuration', [
					'config',
					'--local',
					`submodule.${name}.update`,
					'checkout',
				])
				yield* git(runtime, repositoryPath, 'shallow submodule initialization', [
					'submodule',
					'update',
					'--init',
					'--depth=1',
					'--recommend-shallow',
					'--',
					subPath,
				])
				if ((yield* pathState(submodulePath)) !== 'directory')
					return yield* cloneFailure(
						'SUBMODULE_INIT_FAILED',
						'Git did not create the submodule directory.',
					)
				const realParent = yield* canonicalPath(repositoryPath)
				const realSubmodule = yield* canonicalPath(submodulePath)
				if (!pathIsInside(realParent, realSubmodule) || realParent === realSubmodule)
					return yield* cloneFailure(
						'SUBMODULE_PATH_REJECTED',
						'Initialized submodule escapes its parent.',
					)
				yield* validateCheckout(runtime, submodulePath, cleanUrl)
				const commit = yield* git(runtime, submodulePath, 'submodule commit resolution', [
					'rev-parse',
					'HEAD^{commit}',
				]).pipe(Effect.flatMap(decodeCommit))
				const cycleKey = `${repo}@${commit}`
				if (ancestorCommits.has(cycleKey))
					return yield* cloneFailure(
						'SUBMODULE_INIT_FAILED',
						'Transitive submodule cycle detected.',
					)
				const displayPath = prefix.length === 0 ? subPath : `${prefix}/${subPath}`
				yield* Effect.sync(() =>
					entries.push(
						GitHubSubmodule.make({ path: displayPath, repo, url: cleanUrl, commit, depth }),
					),
				)
				yield* initializeSubmodules(
					runtime,
					config,
					submodulePath,
					repo,
					entries,
					new Set([...ancestorCommits, cycleKey]),
					depth + 1,
					displayPath,
				)
			}
		}),
	)
}

export function withSubmoduleProgress<A>(
	entries: Array<GitHubSubmodule>,
	effect: Effect.Effect<A, CloneFailure>,
) {
	return effect.pipe(
		Effect.mapError(
			(error) =>
				new CloneFailure({
					code: error.code,
					message: error.message,
					submodules: { complete: false, entries, gaps: [error.message] },
				}),
		),
	)
}
