import { Effect, Option } from 'effect'
import type { Processes } from './process'
import { type RemoteRef, type Resolved, SourceError, type SourceRequest } from './schema'
import type { Storage } from './storage'

export const githubRepositoryUrl = (repository: string) => `https://github.com/${repository}.git`

const fullCommit = /^[0-9a-f]{40}$/

export const makeGit = (
	storage: Storage,
	processes: Processes,
	repositoryUrl: (repository: string) => string,
) => {
	const { fs, path, checkPath, stat } = storage
	const { git } = processes
	const probe = <R>(command: Effect.Effect<string, SourceError, R>) =>
		command.pipe(
			Effect.map(Option.some),
			Effect.catchTag('SourceError', () => Effect.succeed(Option.none<string>())),
		)

	/** Commits that `refs` name in `repository`, peeling annotated tags. */
	const listRemote = Effect.fn('SourceGit.listRemote')(function* (
		repository: string,
		refs: ReadonlyArray<string>,
	) {
		const output = yield* git([
			'ls-remote',
			repositoryUrl(repository),
			...refs.flatMap((ref) => [ref, `${ref}^{}`]),
		])
		const advertised = new Map<string, string>()
		for (const line of output.split('\n')) {
			const [commit, name] = line.split('\t')
			if (commit !== undefined && name !== undefined) advertised.set(name, commit)
		}
		return (ref: string) => advertised.get(`${ref}^{}`) ?? advertised.get(ref)
	})
	const resolve = Effect.fn('SourceGit.resolve')(function* (request: SourceRequest) {
		yield* git(['check-ref-format', '--branch', request.ref])
		yield* git(['check-ref-format', '--branch', request.branch])
		const commitOf = yield* listRemote(request.repository, [
			`refs/heads/${request.ref}`,
			`refs/tags/${request.ref}`,
		])
		// Like `git clone --branch`, a branch takes precedence over a tag with the same name.
		const branch = commitOf(`refs/heads/${request.ref}`)
		const tag = commitOf(`refs/tags/${request.ref}`)
		const resolved = yield* Effect.gen(function* () {
			if (branch !== undefined) return { kind: 'branch', commit: branch } as const
			if (tag !== undefined) return { kind: 'tag', commit: tag } as const
			if (fullCommit.test(request.ref)) return { kind: 'commit', commit: request.ref } as const
			return yield* SourceError.make({
				code: 'unknown_ref',
				message: 'The source repository has no such branch or tag.',
			})
		})
		if (request.commit !== undefined && resolved.commit !== request.commit)
			return yield* SourceError.make({
				code: 'stale_ref',
				message: 'The source ref no longer resolves to the requested commit.',
			})
		return resolved satisfies Resolved
	})
	const checkRemoteRefs = Effect.fn('SourceGit.checkRemoteRefs')(function* (
		refs: ReadonlyArray<RemoteRef>,
	) {
		const repositories = [...new Set(refs.map(({ repository }) => repository))]
		for (const repository of repositories) {
			const required = refs.filter((ref) => ref.repository === repository)
			const commitOf = yield* listRemote(
				repository,
				required.map(({ ref }) => ref),
			)
			if (required.some(({ ref, commit }) => commitOf(ref) !== commit))
				return yield* SourceError.make({
					code: 'stale_ref',
					message: 'A required remote ref no longer points at its requested commit.',
				})
		}
	})
	const checkRecoverable = Effect.fn('SourceGit.checkRecoverable')(function* (directory: string) {
		if (!(yield* checkPath(directory, 'Directory'))) return
		const gitDirectory = path.join(directory, '.git')
		if (!(yield* checkPath(gitDirectory, 'Directory'))) return
		if (Option.isSome(yield* stat(path.join(gitDirectory, 'commondir')))) {
			return yield* SourceError.make({
				code: 'ownership_mismatch',
				message: 'An external Git common directory cannot be retained safely.',
			})
		}
		for (const file of [
			'HEAD',
			'packed-refs',
			'config',
			'config.lock',
			'config.worktree',
			'shallow',
			'shallow.lock',
			'FETCH_HEAD',
			'ORIG_HEAD',
			'index',
			'index.lock',
		])
			yield* checkPath(path.join(gitDirectory, file), 'File')
		const alternates = path.join(gitDirectory, 'objects', 'info', 'alternates')
		if (yield* checkPath(alternates, 'File')) {
			const contents = yield* fs.readFileString(alternates)
			if (contents.trim() !== '')
				return yield* SourceError.make({
					code: 'ownership_mismatch',
					message: 'An external Git object store cannot be retained safely.',
				})
		}
		for (const name of ['objects', 'refs']) {
			const store = path.join(gitDirectory, name)
			if (!(yield* checkPath(store, 'Directory'))) continue
			const entries = yield* fs.readDirectory(store, { recursive: true })
			for (const entry of entries) {
				const info = yield* fs.lstat(path.join(store, entry))
				if (info.type !== 'Directory' && info.type !== 'File')
					return yield* SourceError.make({
						code: 'unsafe_path',
						message: 'The checkout Git store contains an external or unsafe entry.',
					})
			}
		}
	})
	const checkClone = Effect.fn('SourceGit.checkClone')(function* (directory: string) {
		if (
			!(yield* checkPath(directory, 'Directory')) ||
			!(yield* checkPath(path.join(directory, '.git'), 'Directory'))
		) {
			return yield* SourceError.make({
				code: 'ownership_mismatch',
				message: 'The source does not contain a standalone owned checkout.',
			})
		}
		yield* checkRecoverable(directory)
		const actualGit = yield* git(['rev-parse', '--absolute-git-dir'], directory)
		if (actualGit !== path.join(directory, '.git')) {
			return yield* SourceError.make({
				code: 'ownership_mismatch',
				message: 'The checkout Git directory is not source-owned.',
			})
		}
	})
	const isCheckedOut = Effect.fn('SourceGit.isCheckedOut')(function* (
		directory: string,
		branch: string,
		commit: string,
	) {
		if (!(yield* checkPath(path.join(directory, '.git', 'index'), 'File'))) return false
		const head = yield* probe(git(['symbolic-ref', '-q', 'HEAD'], directory))
		if (Option.getOrUndefined(head) !== `refs/heads/${branch}`) return false
		const current = yield* git(['rev-parse', '--verify', 'HEAD'], directory)
		return current === commit
	})
	/** A clone nothing has checked out or committed into: every local branch still matches origin. */
	const isUntouchedClone = Effect.fn('SourceGit.isUntouchedClone')(function* (directory: string) {
		for (const file of ['index', 'index.lock'])
			if (yield* checkPath(path.join(directory, '.git', file), 'File')) return false
		const output = yield* git(
			['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes/origin'],
			directory,
		)
		const refs = new Map<string, string>()
		for (const line of output.split('\n')) {
			const [commit, name] = line.split(' ')
			if (commit !== undefined && name !== undefined) refs.set(name, commit)
		}
		return [...refs].every(
			([name, commit]) =>
				!name.startsWith('refs/heads/') ||
				refs.get(`refs/remotes/origin/${name.slice('refs/heads/'.length)}`) === commit,
		)
	})
	const clone = Effect.fn('SourceGit.clone')(function* (
		request: SourceRequest,
		resolved: Resolved,
		staging: string,
	) {
		const url = repositoryUrl(request.repository)
		if (!(yield* checkPath(staging, 'Directory'))) {
			yield* git([
				'clone',
				'--template=',
				'--no-local',
				'--no-hardlinks',
				'--no-single-branch',
				'--no-checkout',
				'--',
				url,
				staging,
			])
		}
		yield* checkClone(staging)
		const origin = yield* git(['config', '--get', 'remote.origin.url'], staging)
		if (origin !== url)
			return yield* SourceError.make({
				code: 'ownership_mismatch',
				message: 'An interrupted clone cannot be safely adopted; its files were retained.',
			})
		if (yield* isCheckedOut(staging, request.branch, resolved.commit)) return
		// Checking out moves the branch, so only a clone without local work may be checked out.
		if (!(yield* isUntouchedClone(staging)))
			return yield* SourceError.make({
				code: 'ownership_mismatch',
				message: 'An interrupted clone has local changes; its files were retained.',
			})
		const present = yield* probe(git(['cat-file', '-e', `${resolved.commit}^{commit}`], staging))
		if (Option.isNone(present))
			yield* git(['fetch', '--no-tags', '--', url, resolved.commit], staging)
		// Untracked files, including ignored ones, are local work that checkout must never replace.
		yield* git(
			['checkout', '--no-track', '--no-overwrite-ignore', '-B', request.branch, resolved.commit],
			staging,
		)
		if (!(yield* isCheckedOut(staging, request.branch, resolved.commit)))
			return yield* SourceError.make({
				code: 'ownership_mismatch',
				message: 'The clone did not check out the resolved commit; its files were retained.',
			})
	})
	/**
	 * Only a checked-out branch tracks its own remote branch. A separate work branch, tag, or commit
	 * has no upstream, so its first push names a destination explicitly; this also drops the
	 * tracking `git clone` gave a reused default branch.
	 */
	const configureTracking = Effect.fn('SourceGit.configureTracking')(function* (
		request: SourceRequest,
		resolved: Resolved,
		staging: string,
	) {
		const remote = `branch.${request.branch}.remote`
		const merge = `branch.${request.branch}.merge`
		if (resolved.kind === 'branch' && request.branch === request.ref) {
			yield* git(['config', remote, 'origin'], staging)
			yield* git(['config', merge, `refs/heads/${request.ref}`], staging)
			return
		}
		for (const key of [remote, merge]) {
			const value = yield* git(['config', '--local', '--get', '--default', '', key], staging)
			if (value !== '') yield* git(['config', '--local', '--unset-all', key], staging)
		}
	})
	const configure = Effect.fn('SourceGit.configure')(function* (
		request: SourceRequest,
		resolved: Resolved,
		staging: string,
	) {
		yield* checkClone(staging)
		const url = repositoryUrl(request.repository)
		yield* git(['config', 'remote.origin.url', url], staging)
		yield* git(['config', 'remote.origin.pushurl', url], staging)
		yield* configureTracking(request, resolved, staging)
		if (request.upstream !== undefined) {
			const { repository, commits } = request.upstream
			const upstream = repositoryUrl(repository)
			yield* git(['config', 'remote.upstream.url', upstream], staging)
			yield* git(
				['config', 'remote.upstream.fetch', '+refs/heads/*:refs/remotes/upstream/*'],
				staging,
			)
			if (commits.length > 0)
				yield* git(['fetch', '--no-tags', '--', upstream, ...commits], staging)
			for (const commit of commits) yield* git(['cat-file', '-e', `${commit}^{commit}`], staging)
		}
		yield* git(['cat-file', '-e', `${resolved.commit}^{commit}`], staging)
		const shallow = yield* git(['rev-parse', '--is-shallow-repository'], staging)
		if (shallow !== 'false')
			return yield* SourceError.make({
				code: 'git_failed',
				message: 'The checkout must retain complete Git history.',
			})
	})
	return { resolve, checkRemoteRefs, checkClone, checkRecoverable, clone, configure }
}
