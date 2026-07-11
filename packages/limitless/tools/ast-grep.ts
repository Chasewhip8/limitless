import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { ToolContext } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin'
import { Effect, Schema } from 'effect'
import {
	CommandResult,
	DEFAULT_TIMEOUT_MS,
	PositiveFiniteTimeout,
	runCommand,
} from '../core/command'
import { isMissingPath, toolOperationError } from '../core/errors'
import { pathsOverlap, workspaceRoot } from '../core/paths'
import { managedReposRoot } from '../core/storage'
import { executeTool } from '../core/tool-boundary'

export const AstGrepSearchInput = Schema.Struct({
	pattern: Schema.NonEmptyString,
	lang: Schema.optional(Schema.String),
	language: Schema.optional(Schema.String),
	paths: Schema.optional(Schema.Array(Schema.String)),
	workspace: Schema.optional(Schema.String),
	json: Schema.optional(Schema.Boolean),
	timeoutMs: Schema.optional(PositiveFiniteTimeout),
})
export type AstGrepSearchInput = typeof AstGrepSearchInput.Type

export const AstGrepReplaceInput = Schema.Struct({
	pattern: Schema.NonEmptyString,
	rewrite: Schema.NonEmptyString,
	lang: Schema.optional(Schema.String),
	language: Schema.optional(Schema.String),
	paths: Schema.optional(Schema.Array(Schema.String)),
	workspace: Schema.optional(Schema.String),
	dryRun: Schema.optional(Schema.Boolean),
	timeoutMs: Schema.optional(PositiveFiniteTimeout),
})
export type AstGrepReplaceInput = typeof AstGrepReplaceInput.Type

export const AstGrepSearchResult = Schema.Struct({ ...CommandResult.fields })
export type AstGrepSearchResult = typeof AstGrepSearchResult.Type

export const AstGrepReplaceCommandResult = Schema.Struct({
	...CommandResult.fields,
	dryRun: Schema.Boolean,
})
export const AstGrepMutationBlockedResult = Schema.Struct({
	ok: Schema.Literal(false),
	error: Schema.String,
	dryRun: Schema.Literal(false),
})
export const AstGrepReplaceResult = Schema.Union([
	AstGrepReplaceCommandResult,
	AstGrepMutationBlockedResult,
])
export type AstGrepReplaceResult = typeof AstGrepReplaceResult.Type

export const AST_GREP_BIN = '@AST_GREP_BIN@'

function relativeTargets(input: AstGrepSearchInput | AstGrepReplaceInput) {
	const paths = input.paths ?? ['.']
	return paths.length === 0 ? ['.'] : paths
}

function astGrepLanguage(input: AstGrepSearchInput | AstGrepReplaceInput): string {
	return input.lang ?? input.language ?? 'typescript'
}

function astGrepJson(input: AstGrepSearchInput): boolean {
	return input.json ?? true
}

const existingRealPath = Effect.fn(function* existingRealPath(filePath: string) {
	return yield* Effect.tryPromise({
		try: () => realpath(filePath),
		catch: (error) =>
			toolOperationError('ast_grep_replace', 'Could not inspect ast-grep mutation scope', error),
	}).pipe(
		Effect.matchEffect({
			onFailure: (error) => (isMissingPath(error) ? Effect.void : Effect.fail(error)),
			onSuccess: Effect.succeed,
		}),
	)
})

export const astGrepMutationScopeGap = Effect.fn(function* astGrepMutationScopeGap(
	worktree: string,
	workspace: string,
	targets: ReadonlyArray<string>,
) {
	const managedRoot = managedReposRoot(worktree)
	const realManagedRoot = yield* existingRealPath(managedRoot)
	if (realManagedRoot === undefined) return undefined
	for (const target of targets) {
		const absoluteTarget = path.isAbsolute(target)
			? path.resolve(target)
			: path.resolve(workspace, target)
		if (pathsOverlap(absoluteTarget, managedRoot)) {
			return 'ast_grep_replace cannot mutate a scope inside or encompassing .limitless/repos; managed GitHub clones are read-only.'
		}
		const realTarget = yield* existingRealPath(absoluteTarget)
		if (realTarget !== undefined && pathsOverlap(realTarget, realManagedRoot)) {
			return 'ast_grep_replace cannot mutate a symlinked scope inside or encompassing .limitless/repos; managed GitHub clones are read-only.'
		}
	}
	return undefined
})

export const astGrepSearch = Effect.fn(function* astGrepSearch(
	input: AstGrepSearchInput,
	context: ToolContext,
) {
	const cwd = workspaceRoot(input, context)
	const args = ['run', '--pattern', input.pattern, '--lang', astGrepLanguage(input)]
	if (astGrepJson(input)) args.push('--json=pretty')
	args.push(...relativeTargets(input))

	const result = yield* runCommand(AST_GREP_BIN, args, {
		cwd,
		timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	})
	return AstGrepSearchResult.make(result)
})

export const astGrepReplace = Effect.fn(function* astGrepReplace(
	input: AstGrepReplaceInput,
	context: ToolContext,
) {
	const dryRun = input.dryRun ?? true
	const cwd = workspaceRoot(input, context)
	const targets = relativeTargets(input)
	if (!dryRun) {
		const gap = yield* astGrepMutationScopeGap(context.worktree, cwd, targets)
		if (gap !== undefined) {
			return AstGrepMutationBlockedResult.make({ ok: false, error: gap, dryRun })
		}
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
	return AstGrepReplaceCommandResult.make({ ...result, dryRun })
})

export function astGrepTools() {
	return {
		ast_grep_search: tool({
			description: 'Search code with ast-grep using the packaged binary.',
			args: {
				pattern: tool.schema.string(),
				lang: tool.schema.string().optional(),
				language: tool.schema.string().optional(),
				paths: tool.schema.array(tool.schema.string()).optional(),
				workspace: tool.schema.string().optional(),
				json: tool.schema.boolean().optional(),
				timeoutMs: tool.schema.number().optional(),
			},
			execute: (args, context) =>
				executeTool(
					'ast_grep_search',
					AstGrepSearchInput,
					AstGrepSearchResult,
					args,
					context,
					(input) => astGrepSearch(input, context),
				),
		}),
		ast_grep_replace: tool({
			description: 'Rewrite code with ast-grep. Dry-run is enabled by default.',
			args: {
				pattern: tool.schema.string(),
				rewrite: tool.schema.string(),
				lang: tool.schema.string().optional(),
				language: tool.schema.string().optional(),
				paths: tool.schema.array(tool.schema.string()).optional(),
				workspace: tool.schema.string().optional(),
				dryRun: tool.schema.boolean().optional(),
				timeoutMs: tool.schema.number().optional(),
			},
			execute: (args, context) =>
				executeTool(
					'ast_grep_replace',
					AstGrepReplaceInput,
					AstGrepReplaceResult,
					args,
					context,
					(input) => astGrepReplace(input, context),
				),
		}),
	}
}
