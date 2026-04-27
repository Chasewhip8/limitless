import path from 'node:path'
import { type Plugin, tool } from '@opencode-ai/plugin'
import { Effect, Schema } from 'effect'
import {
	LspReferencesInput,
	LspRenameInput,
	LspSymbolsInput,
	lspReferences,
	lspRename,
	lspSymbols,
} from './lsp'
import {
	type CommandResult,
	DEFAULT_TIMEOUT_MS,
	executeTool,
	findExecutable,
	findUp,
	runCommand,
	workspaceRoot,
} from './shared'

const AST_GREP_BIN = '@AST_GREP_BIN@'

const AstGrepSearchInput = Schema.Struct({
	pattern: Schema.String,
	lang: Schema.optional(Schema.String),
	language: Schema.optional(Schema.String),
	paths: Schema.optional(Schema.Array(Schema.String)),
	workspace: Schema.optional(Schema.String),
	json: Schema.optional(Schema.Boolean),
	timeoutMs: Schema.optional(Schema.Finite),
})

type AstGrepSearchInput = typeof AstGrepSearchInput.Type

const AstGrepReplaceInput = Schema.Struct({
	pattern: Schema.String,
	rewrite: Schema.String,
	lang: Schema.optional(Schema.String),
	language: Schema.optional(Schema.String),
	paths: Schema.optional(Schema.Array(Schema.String)),
	workspace: Schema.optional(Schema.String),
	dryRun: Schema.optional(Schema.Boolean),
	timeoutMs: Schema.optional(Schema.Finite),
})

type AstGrepReplaceInput = typeof AstGrepReplaceInput.Type

const DiagnosticsInput = Schema.Struct({
	workspace: Schema.optional(Schema.String),
	filePath: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
})

type DiagnosticsInput = typeof DiagnosticsInput.Type

type SkippedCheck = {
	readonly name: string
	readonly ok: false
	readonly skipped: true
	readonly reason: string
}

type ExecutedCheck = CommandResult & {
	readonly name: string
	readonly command: string
	readonly config: string
}

type DiagnosticCheck = SkippedCheck | ExecutedCheck

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

function astGrepSearch(input: AstGrepSearchInput) {
	if (input.pattern.length === 0) return Effect.succeed({ ok: false, error: 'pattern is required' })

	const cwd = workspaceRoot(input)
	const args = ['run', '--pattern', input.pattern, '--lang', astGrepLanguage(input)]
	if (astGrepJson(input)) args.push('--json=pretty')
	args.push(...relativeTargets(input))

	return runCommand(AST_GREP_BIN, args, {
		cwd,
		timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	})
}

function astGrepReplace(input: AstGrepReplaceInput) {
	if (input.pattern.length === 0) return Effect.succeed({ ok: false, error: 'pattern is required' })
	if (input.rewrite.length === 0) return Effect.succeed({ ok: false, error: 'rewrite is required' })

	const dryRun = input.dryRun ?? true
	const cwd = workspaceRoot(input)
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

	return runCommand(AST_GREP_BIN, args, {
		cwd,
		timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	}).pipe(Effect.map((result) => ({ ...result, dryRun })))
}

function skippedCheck(name: string, reason: string): SkippedCheck {
	return {
		name,
		ok: false,
		skipped: true,
		reason,
	}
}

function lspDiagnostics(input: DiagnosticsInput) {
	return Effect.gen(function* () {
		const cwd = workspaceRoot(input)
		const filePath = input.filePath ?? input.path ?? '.'
		const target = path.resolve(cwd, filePath)
		const checks: Array<DiagnosticCheck> = []

		const tsconfig = yield* findUp(['tsconfig.json', 'jsconfig.json'], target)
		if (tsconfig) {
			const configDirectory = path.dirname(tsconfig)
			const tsc = yield* findExecutable('tsc', configDirectory)
			const result = yield* runCommand(tsc, ['--noEmit', '--pretty', 'false', '-p', tsconfig], {
				cwd: configDirectory,
			})
			checks.push({ name: 'typescript', command: tsc, config: tsconfig, ...result })
		} else {
			checks.push(skippedCheck('typescript', 'No tsconfig.json or jsconfig.json found.'))
		}

		const biomeConfig = yield* findUp(['biome.json', 'biome.jsonc'], target)
		if (biomeConfig) {
			const biome = yield* findExecutable('biome', path.dirname(biomeConfig))
			const result = yield* runCommand(biome, ['check', filePath], { cwd })
			checks.push({ name: 'biome', command: biome, config: biomeConfig, ...result })
		} else {
			checks.push(skippedCheck('biome', 'No biome.json or biome.jsonc found.'))
		}

		return {
			ok: checks.every((check) => check.ok || ('skipped' in check && check.skipped)),
			checks,
		}
	})
}

const pathArgs = {
	workspace: tool.schema.string().optional(),
	filePath: tool.schema.string().optional(),
	path: tool.schema.string().optional(),
}

const positionArgs = {
	...pathArgs,
	server: tool.schema.string().optional(),
	timeoutMs: tool.schema.number().optional(),
	offset: tool.schema.number().optional(),
	line: tool.schema.number().optional(),
	character: tool.schema.number().optional(),
}

export function createLimitless(): Plugin {
	return async (pluginInput) => ({
		tool: {
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
				execute(args, context) {
					return executeTool('ast_grep_search', AstGrepSearchInput, args, context, (input) =>
						astGrepSearch(input),
					)
				},
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
				execute(args, context) {
					return executeTool('ast_grep_replace', AstGrepReplaceInput, args, context, (input) =>
						astGrepReplace(input),
					)
				},
			}),
			lsp_diagnostics: tool({
				description: 'Run safe local diagnostics for TS/JS projects.',
				args: pathArgs,
				execute(args, context) {
					return executeTool('lsp_diagnostics', DiagnosticsInput, args, context, (input) =>
						lspDiagnostics(input),
					)
				},
			}),
			lsp_references: tool({
				description:
					'Find references through the configured language server for a zero-based file position.',
				args: {
					...positionArgs,
					includeDeclaration: tool.schema.boolean().optional(),
					maxResults: tool.schema.number().optional(),
				},
				execute(args, context) {
					return executeTool('lsp_references', LspReferencesInput, args, context, (input) =>
						lspReferences(pluginInput, input, context),
					)
				},
			}),
			lsp_symbols: tool({
				description: 'Find document or workspace symbols through configured language servers.',
				args: {
					...pathArgs,
					server: tool.schema.string().optional(),
					timeoutMs: tool.schema.number().optional(),
					query: tool.schema.string().optional(),
					maxResults: tool.schema.number().optional(),
				},
				execute(args, context) {
					return executeTool('lsp_symbols', LspSymbolsInput, args, context, (input) =>
						lspSymbols(pluginInput, input, context),
					)
				},
			}),
			lsp_rename: tool({
				description:
					'Preview rename edits from the configured language server without writing files.',
				args: {
					...positionArgs,
					newName: tool.schema.string(),
				},
				execute(args, context) {
					return executeTool('lsp_rename', LspRenameInput, args, context, (input) =>
						lspRename(pluginInput, input, context),
					)
				},
			}),
		},
	})
}

export default createLimitless()
