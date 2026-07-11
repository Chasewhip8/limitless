import { lstat, mkdir, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Effect } from 'effect'
import { pathIsInside } from '../../core/paths'
import { managedReposRoot } from '../../core/storage'
import { objectProperty } from '../../lib/guards'
import { optionalField } from '../../lib/type-utils'
import { CloneFailure, cloneFailure } from './errors'
import { git } from './git'
import { cleanRemoteUrl } from './repository'
import type { GitRuntime } from './runtime'

function filesystemFailure(action: string, error: unknown) {
	const causeCode = objectProperty(error, 'code')
	return new CloneFailure({
		code: 'GITHUB_CLONE_FAILED',
		message: typeof causeCode === 'string' ? `${action} (${causeCode})` : action,
		...optionalField('causeCode', typeof causeCode === 'string' ? causeCode : undefined),
	})
}

function isMissing(error: CloneFailure): boolean {
	return error.causeCode === 'ENOENT' || error.causeCode === 'ENOTDIR'
}

export const pathState = Effect.fn('pathState')(function* (filePath: string) {
	const stat = yield* Effect.tryPromise({
		try: () => lstat(filePath),
		catch: (error) => filesystemFailure('Failed to inspect managed repository path', error),
	}).pipe(
		Effect.matchEffect({
			onFailure: (error) => (isMissing(error) ? Effect.void : Effect.fail(error)),
			onSuccess: Effect.succeed,
		}),
	)
	if (stat === undefined) return 'missing' as const
	if (stat.isSymbolicLink()) return 'symlink' as const
	if (stat.isDirectory()) return 'directory' as const
	return 'other' as const
})

export const makeDirectory = Effect.fn('makeDirectory')(function* (directory: string) {
	return yield* Effect.tryPromise({
		try: () => mkdir(directory),
		catch: (error) => filesystemFailure('Failed to create managed repository directory', error),
	})
})

const makeDirectoryIfMissing = Effect.fn('makeDirectoryIfMissing')(function* (directory: string) {
	return yield* Effect.tryPromise({
		try: () => mkdir(directory),
		catch: (error) => filesystemFailure('Failed to create managed repository directory', error),
	}).pipe(
		Effect.matchEffect({
			onFailure: (error) => (error.causeCode === 'EEXIST' ? Effect.void : Effect.fail(error)),
			onSuccess: () => Effect.void,
		}),
	)
})

export const canonicalPath = Effect.fn('canonicalPath')(function* (filePath: string) {
	return yield* Effect.tryPromise({
		try: () => realpath(filePath),
		catch: (error) => filesystemFailure('Failed to resolve managed repository path', error),
	})
})

export const movePath = Effect.fn('movePath')(function* (source: string, target: string) {
	return yield* Effect.tryPromise({
		try: () => rename(source, target),
		catch: (error) => filesystemFailure('Failed to publish managed repository checkout', error),
	})
})

export const removeTree = Effect.fn('removeTree')(function* (directory: string) {
	return yield* Effect.tryPromise({
		try: () => rm(directory, { recursive: true, force: true }),
		catch: (error) => filesystemFailure('Failed to clean managed repository staging path', error),
	})
})

export const ensureManagedRoot = Effect.fn('ensureManagedRoot')(function* (worktree: string) {
	const root = managedReposRoot(worktree)
	for (const { directory, label } of [
		{ label: 'Limitless storage directory', directory: path.dirname(root) },
		{ label: 'Managed repository root', directory: root },
	]) {
		const state = yield* pathState(directory)
		if (state === 'symlink')
			return yield* cloneFailure('UNSAFE_STORAGE_PATH', `${label} cannot be a symbolic link.`)
		if (state === 'other')
			return yield* cloneFailure('UNSAFE_STORAGE_PATH', `${label} must be a directory.`)
		if (state === 'missing') {
			yield* makeDirectoryIfMissing(directory)
			if ((yield* pathState(directory)) !== 'directory')
				return yield* cloneFailure('UNSAFE_STORAGE_PATH', `${label} must be a directory.`)
		}
	}
	const realWorktree = yield* canonicalPath(worktree)
	const realRoot = yield* canonicalPath(root)
	if (!pathIsInside(realWorktree, realRoot))
		return yield* cloneFailure(
			'UNSAFE_STORAGE_PATH',
			'Managed repository storage escapes the worktree.',
		)
	return root
})

export const validateCheckout = Effect.fn('validateCheckout')(function* (
	runtime: GitRuntime,
	target: string,
	expectedUrl: string,
) {
	if ((yield* pathState(target)) !== 'directory')
		return yield* cloneFailure('CHECKOUT_IDENTITY_MISMATCH', 'Managed checkout is not a directory.')
	const top = yield* git(runtime, target, 'checkout identity inspection', [
		'rev-parse',
		'--show-toplevel',
	])
	if ((yield* canonicalPath(target)) !== (yield* canonicalPath(top)))
		return yield* cloneFailure(
			'CHECKOUT_IDENTITY_MISMATCH',
			'Managed checkout does not identify itself as the expected repository root.',
		)
	const origins = (yield* git(runtime, target, 'origin inspection', [
		'config',
		'--local',
		'--get-all',
		'remote.origin.url',
	]))
		.split(/\r?\n/gu)
		.filter((line) => line.length > 0)
	if (origins.length !== 1 || origins[0] !== expectedUrl)
		return yield* cloneFailure(
			'CHECKOUT_IDENTITY_MISMATCH',
			'Managed checkout origin does not match the requested GitHub repository.',
		)
})

export const assertClean = Effect.fn('assertClean')(function* (
	runtime: GitRuntime,
	target: string,
) {
	const status = yield* git(runtime, target, 'working tree status inspection', [
		'status',
		'--porcelain=v1',
		'--untracked-files=all',
		'--ignore-submodules=none',
	])
	if (status.length > 0)
		return yield* cloneFailure(
			'DIRTY_CHECKOUT',
			'Managed checkout has tracked, untracked, or submodule changes; refusing to update it.',
		)
})

export function expectedRemote(repo: string): string {
	return cleanRemoteUrl(repo)
}
