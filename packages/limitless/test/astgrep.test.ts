import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Option, Schema } from 'effect'
import { runPromise } from 'effect/Effect'
import { afterEach, describe, expect, test } from 'vitest'
import {
	AstGrepReplaceInput,
	AstGrepSearchInput,
	astGrepMutationScopeGap,
	astGrepReplace,
} from '../tools/ast-grep'

const tempDirectories: Array<string> = []
type AstGrepContext = Parameters<typeof astGrepReplace>[1]

function context(root: string): AstGrepContext {
	return {
		sessionID: 'session',
		messageID: 'message',
		agent: 'limitless',
		directory: root,
		worktree: root,
		abort: new AbortController().signal,
		metadata: () => undefined,
		ask: () => {
			throw new Error('ask is not used by ast-grep tests')
		},
	}
}

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
		await expect(runPromise(astGrepMutationScopeGap(root, root, ['.']))).resolves.toBeUndefined()
	})

	test('blocks mutation scopes inside or encompassing managed repositories', async () => {
		const root = await worktree()
		const managed = path.join(root, '.limitless', 'repos')
		await mkdir(managed, { recursive: true })

		await expect(runPromise(astGrepMutationScopeGap(root, root, ['.']))).resolves.toContain(
			'read-only',
		)
		await expect(runPromise(astGrepMutationScopeGap(root, managed, ['.']))).resolves.toContain(
			'read-only',
		)
		await expect(runPromise(astGrepMutationScopeGap(root, root, ['src']))).resolves.toBeUndefined()
		await expect(
			runPromise(astGrepReplace({ pattern: '$A', rewrite: '$A', dryRun: false }, context(root))),
		).resolves.toEqual({
			ok: false,
			error:
				'ast_grep_replace cannot mutate a scope inside or encompassing .limitless/repos; managed GitHub clones are read-only.',
			dryRun: false,
		})
	})

	test('blocks symlink aliases into managed repositories', async () => {
		const root = await worktree()
		const managed = path.join(root, '.limitless', 'repos')
		await mkdir(managed, { recursive: true })
		await symlink(managed, path.join(root, 'upstream-source'))

		await expect(
			runPromise(astGrepMutationScopeGap(root, root, ['upstream-source'])),
		).resolves.toContain('symlinked')
	})
})

describe('ast-grep input schemas', () => {
	test('rejects empty patterns, rewrites, and non-positive timeouts', () => {
		for (const [schema, input] of [
			[AstGrepSearchInput, { pattern: '' }],
			[AstGrepSearchInput, { pattern: '$A', timeoutMs: 0 }],
			[AstGrepReplaceInput, { pattern: '$A', rewrite: '' }],
		] as const) {
			expect(Option.isNone(Schema.decodeUnknownOption(schema)(input))).toBe(true)
		}
	})
})
