import type { ToolContext } from '@opencode-ai/plugin'
import { Effect } from 'effect'
import type {
	AstGrepReplaceInput as AstGrepReplaceInputType,
	AstGrepSearchInput as AstGrepSearchInputType,
} from './lib/astgrep'
import { DEFAULT_TIMEOUT_MS, runCommand, workspaceRoot } from './shared'

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
	args.push(...relativeTargets(input))

	const result = yield* runCommand(AST_GREP_BIN, args, {
		cwd,
		timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	})
	return { ...result, dryRun }
})
