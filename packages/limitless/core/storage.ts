import path from 'node:path'

export const LIMITLESS_STORAGE_DIRECTORY = '.limitless'
export const ARTIFACTS_STORAGE_DIRECTORY = 'artifacts'
export const MANAGED_REPOS_STORAGE_DIRECTORY = 'repos'

export const ARTIFACTS_STORAGE_RELATIVE_PATH = path.posix.join(
	LIMITLESS_STORAGE_DIRECTORY,
	ARTIFACTS_STORAGE_DIRECTORY,
)
export const MANAGED_REPOS_STORAGE_RELATIVE_PATH = path.posix.join(
	LIMITLESS_STORAGE_DIRECTORY,
	MANAGED_REPOS_STORAGE_DIRECTORY,
)

export function limitlessStorageRoot(worktree: string): string {
	return path.resolve(worktree, LIMITLESS_STORAGE_DIRECTORY)
}

export function artifactsStorageRoot(worktree: string): string {
	return path.resolve(limitlessStorageRoot(worktree), ARTIFACTS_STORAGE_DIRECTORY)
}

export function managedReposRoot(worktree: string): string {
	return path.resolve(limitlessStorageRoot(worktree), MANAGED_REPOS_STORAGE_DIRECTORY)
}
