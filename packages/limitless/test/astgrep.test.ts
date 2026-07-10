import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { astGrepMutationScopeGap } from '../astgrep'

const tempDirectories: Array<string> = []

async function worktree(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'limitless-astgrep-'))
	tempDirectories.push(directory)
	return directory
}

afterEach(async () => {
	await Promise.all(
		tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	)
})

describe('ast-grep managed repository guardrail', () => {
	test('allows broad mutations before the managed repository root exists', async () => {
		const root = await worktree()
		await expect(astGrepMutationScopeGap(root, root, ['.'])).resolves.toBeUndefined()
	})

	test('blocks mutation scopes inside or encompassing managed repositories', async () => {
		const root = await worktree()
		const managed = path.join(root, '.limitless', 'repos')
		await mkdir(managed, { recursive: true })

		await expect(astGrepMutationScopeGap(root, root, ['.'])).resolves.toContain('read-only')
		await expect(astGrepMutationScopeGap(root, managed, ['.'])).resolves.toContain('read-only')
		await expect(astGrepMutationScopeGap(root, root, ['src'])).resolves.toBeUndefined()
	})

	test('blocks symlink aliases into managed repositories', async () => {
		const root = await worktree()
		const managed = path.join(root, '.limitless', 'repos')
		await mkdir(managed, { recursive: true })
		await symlink(managed, path.join(root, 'upstream-source'))

		await expect(astGrepMutationScopeGap(root, root, ['upstream-source'])).resolves.toContain(
			'symlinked',
		)
	})
})
