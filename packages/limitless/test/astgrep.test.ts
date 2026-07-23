import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Effect, Option, Schema } from 'effect'
import { runPromise } from 'effect/Effect'
import { afterEach, describe, expect, test } from 'vitest'
import { ToolExecutionContext } from '../core/execution'
import {
	AstGrepReplaceInput,
	AstGrepSearchInput,
	astGrepMutationScopeGap,
	astGrepReplace,
	astGrepSearch,
} from '../tools/ast-grep'
import { testToolExecution } from './execution'

const tempDirectories: Array<string> = []
async function worktree(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'limitless-astgrep-'))
	tempDirectories.push(directory)
	return directory
}

async function fakeAstGrep(root: string): Promise<string> {
	const binary = path.join(root, 'ast-grep.mjs')
	await writeFile(
		binary,
		'#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n',
	)
	await chmod(binary, 0o755)
	return binary
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
			runPromise(
				astGrepReplace({ pattern: '$A', rewrite: '$A', dryRun: false }).pipe(
					Effect.provideService(ToolExecutionContext, testToolExecution(root)),
				),
			),
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

describe('ast-grep command execution', () => {
	test('executes searches with explicit language, JSON output, and targets', async () => {
		const root = await worktree()
		const binary = await fakeAstGrep(root)
		const result = await runPromise(
			astGrepSearch(
				{ pattern: 'console.log($A)', lang: 'javascript', paths: ['src'] },
				{ binary },
			).pipe(Effect.provideService(ToolExecutionContext, testToolExecution(root))),
		)

		expect(result.ok).toBe(true)
		expect(JSON.parse(result.stdout)).toEqual([
			'run',
			'--pattern',
			'console.log($A)',
			'--lang',
			'javascript',
			'--json=pretty',
			'src',
		])
	})

	test('executes dry-run and update replacements with the intended flags', async () => {
		const root = await worktree()
		const binary = await fakeAstGrep(root)
		const execute = (dryRun: boolean) =>
			runPromise(
				astGrepReplace({ pattern: '$A', rewrite: '$B', dryRun, paths: ['src'] }, { binary }).pipe(
					Effect.provideService(ToolExecutionContext, testToolExecution(root)),
				),
			)

		const [dryRun, update] = await Promise.all([execute(true), execute(false)])
		expect(dryRun.ok).toBe(true)
		expect(update.ok).toBe(true)
		if (!('stdout' in dryRun) || !('stdout' in update)) {
			throw new Error('Expected ast-grep replacement commands to execute')
		}
		expect(JSON.parse(dryRun.stdout)).toContain('--json=pretty')
		expect(JSON.parse(update.stdout)).toContain('--update-all')
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
