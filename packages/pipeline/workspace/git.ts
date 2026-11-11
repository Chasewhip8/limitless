import { Effect, Option } from 'effect'
import type { Processes } from './process'
import { type PrepareInput, WorkspaceError } from './schema'
import type { Storage } from './storage'

export const githubRepositoryUrl = (repository: string) => `https://github.com/${repository}.git`

export const makeGit = (
	storage: Storage,
	processes: Processes,
	repositoryUrl: (repository: string) => string,
) => {
	const { fs, path, checkPath, stat } = storage
	const { git } = processes
	const checkRemoteHead = Effect.fn('WorkspaceGit.checkRemoteHead')(function* (
		input: PrepareInput,
	) {
		const pullRef = `refs/pull/${input.prNumber}/head`
		const branchRef = `refs/heads/${input.headRef}`
		const pull = yield* git(['ls-remote', '--refs', repositoryUrl(input.repository), pullRef])
		const source = yield* git([
			'ls-remote',
			'--refs',
			repositoryUrl(input.sourceRepository),
			branchRef,
		])
		if (pull !== `${input.headSha}\t${pullRef}` || source !== `${input.headSha}\t${branchRef}`) {
			return yield* WorkspaceError.make({
				code: 'stale_head',
				message: 'The remote pull request or source branch no longer has the requested head.',
			})
		}
	})
	const checkClone = Effect.fn('WorkspaceGit.checkClone')(function* (directory: string) {
		if (
			!(yield* checkPath(directory, 'Directory')) ||
			!(yield* checkPath(path.join(directory, '.git'), 'Directory'))
		) {
			return yield* WorkspaceError.make({
				code: 'ownership_mismatch',
				message: 'The task does not contain a standalone owned checkout.',
			})
		}
		yield* checkRecoverable(directory)
		const actualGit = yield* git(['rev-parse', '--absolute-git-dir'], directory)
		if (actualGit !== path.join(directory, '.git')) {
			return yield* WorkspaceError.make({
				code: 'ownership_mismatch',
				message: 'The checkout Git directory is not task-owned.',
			})
		}
	})
	const checkRecoverable = Effect.fn('WorkspaceGit.checkRecoverable')(function* (
		directory: string,
	) {
		if (!(yield* checkPath(directory, 'Directory'))) return
		const gitDirectory = path.join(directory, '.git')
		if (!(yield* checkPath(gitDirectory, 'Directory'))) return
		if (Option.isSome(yield* stat(path.join(gitDirectory, 'commondir')))) {
			return yield* WorkspaceError.make({
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
				return yield* WorkspaceError.make({
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
					return yield* WorkspaceError.make({
						code: 'unsafe_path',
						message: 'The checkout Git store contains an external or unsafe entry.',
					})
			}
		}
	})
	const clone = Effect.fn('WorkspaceGit.clone')(function* (input: PrepareInput, staging: string) {
		yield* git(['check-ref-format', '--branch', input.headRef])
		if (!(yield* checkPath(staging, 'Directory'))) {
			yield* git([
				'clone',
				'--template=',
				'--no-local',
				'--no-hardlinks',
				'--no-single-branch',
				'--branch',
				input.headRef,
				'--',
				repositoryUrl(input.sourceRepository),
				staging,
			])
		}
		yield* checkClone(staging)
		const origin = yield* git(['config', '--get', 'remote.origin.url'], staging)
		const head = yield* git(['rev-parse', 'HEAD'], staging)
		const branch = yield* git(['symbolic-ref', 'HEAD'], staging)
		if (
			origin !== repositoryUrl(input.sourceRepository) ||
			head !== input.headSha ||
			branch !== `refs/heads/${input.headRef}`
		) {
			return yield* WorkspaceError.make({
				code: 'ownership_mismatch',
				message: 'An interrupted clone cannot be safely adopted; its files were retained.',
			})
		}
	})
	const configure = Effect.fn('WorkspaceGit.configure')(function* (
		input: PrepareInput,
		staging: string,
	) {
		yield* checkClone(staging)
		yield* git(['config', 'remote.origin.url', repositoryUrl(input.sourceRepository)], staging)
		yield* git(['config', 'remote.origin.pushurl', repositoryUrl(input.sourceRepository)], staging)
		yield* git(['config', `branch.${input.headRef}.remote`, 'origin'], staging)
		yield* git(['config', `branch.${input.headRef}.merge`, `refs/heads/${input.headRef}`], staging)
		yield* git(['config', 'remote.upstream.url', repositoryUrl(input.repository)], staging)
		yield* git(
			['fetch', '--no-tags', '--', repositoryUrl(input.repository), input.baseSha],
			staging,
		)
		yield* git(['cat-file', '-e', `${input.baseSha}^{commit}`], staging)
		yield* git(['cat-file', '-e', `${input.headSha}^{commit}`], staging)
		const shallow = yield* git(['rev-parse', '--is-shallow-repository'], staging)
		if (shallow !== 'false')
			return yield* WorkspaceError.make({
				code: 'git_failed',
				message: 'The checkout must retain complete Git history.',
			})
	})
	return { checkRemoteHead, checkClone, checkRecoverable, clone, configure }
}
