import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { ToolContext } from '@opencode-ai/plugin'
import { Effect } from 'effect'
import type {
	AstGrepReplaceInput as AstGrepReplaceInputType,
	AstGrepSearchInput as AstGrepSearchInputType,
} from './lib/astgrep'
import {
	DEFAULT_TIMEOUT_MS,
	describeUnknown,
	managedReposRoot,
	pathsOverlap,
	runCommand,
	ToolInputError,
	workspaceRoot,
} from './shared'

export {
	AstGrepReplaceInput,
	type AstGrepReplaceInput as AstGrepReplaceInputType,
	AstGrepSearchInput,
	type AstGrepSearchInput as AstGrepSearchInputType,
} from './lib/astgrep'

export const AST_GREP_BIN = '@AST_GREP_BIN@'

function relativeTargets(input: { readonly paths?: ReadonlyArray<string> | undefined }) {
	const paths = input.paths ?? ['.']
	return paths.length === 0 ? ['.'] : paths
}

function astGrepLanguage(input: {
	readonly lang?: string | undefined
	readonly language?: string | undefined
}): string {
	return input.lang ?? input.language ?? 'typescript'
}

function astGrepJson(input: { readonly json?: boolean | undefined }): boolean {
	return input.json ?? true
}

async function existingRealPath(filePath: string): Promise<string | undefined> {
	try {
		return await realpath(filePath)
	} catch (error) {
		if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') {
			return undefined
		}
		throw error
	}
}

export async function astGrepMutationScopeGap(
	worktree: string,
	workspace: string,
	targets: ReadonlyArray<string>,
): Promise<string | undefined> {
	const managedRoot = managedReposRoot(worktree)
	const realManagedRoot = await existingRealPath(managedRoot)
	if (realManagedRoot === undefined) return undefined
	for (const target of targets) {
		const absoluteTarget = path.isAbsolute(target)
			? path.resolve(target)
			: path.resolve(workspace, target)
		if (pathsOverlap(absoluteTarget, managedRoot)) {
			return 'ast_grep_replace cannot mutate a scope inside or encompassing .limitless/repos; managed GitHub clones are read-only.'
		}
		const realTarget = await existingRealPath(absoluteTarget)
		if (realTarget !== undefined && pathsOverlap(realTarget, realManagedRoot)) {
			return 'ast_grep_replace cannot mutate a symlinked scope inside or encompassing .limitless/repos; managed GitHub clones are read-only.'
		}
	}
	return undefined
}

export const astGrepSearch = Effect.fn(function* astGrepSearch(
	input: AstGrepSearchInputType,
	context: ToolContext,
) {
	if (input.pattern.length === 0) return { ok: false, error: 'pattern is required' }

	const cwd = workspaceRoot(input, context)
	const args = ['run', '--pattern', input.pattern, '--lang', astGrepLanguage(input)]
	if (astGrepJson(input)) args.push('--json=pretty')
	args.push(...relativeTargets(input))

	return yield* runCommand(AST_GREP_BIN, args, {
		cwd,
		timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	})
})

export const astGrepReplace = Effect.fn(function* astGrepReplace(
	input: AstGrepReplaceInputType,
	context: ToolContext,
) {
	if (input.pattern.length === 0) return { ok: false, error: 'pattern is required' }
	if (input.rewrite.length === 0) return { ok: false, error: 'rewrite is required' }

	const dryRun = input.dryRun ?? true
	const cwd = workspaceRoot(input, context)
	const targets = relativeTargets(input)
	if (!dryRun) {
		const gap = yield* Effect.tryPromise({
			try: () => astGrepMutationScopeGap(context.worktree, cwd, targets),
			catch: (error) =>
				new ToolInputError({ tool: 'ast_grep_replace', message: describeUnknown(error) }),
		})
		if (gap !== undefined) return { ok: false, error: gap, dryRun }
	}
	const args = [
		'run',
		'--pattern',
		input.pattern,
		'--rewrite',
		input.rewrite,
		'--lang',
		astGrepLanguage(input),
	]
	if (dryRun) args.push('--json=pretty')
	else args.push('--update-all')
	args.push(...targets)

	const result = yield* runCommand(AST_GREP_BIN, args, {
		cwd,
		timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	})
	return { ...result, dryRun }
})
