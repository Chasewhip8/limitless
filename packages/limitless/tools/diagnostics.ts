import path from 'node:path'
import { Effect, Schema } from 'effect'
import { CommandResult, runCommand } from '../core/command'
import { ToolExecutionContext } from '../core/execution'
import { findExecutable, findUp } from '../core/filesystem'
import { workspacePath, workspaceRoot } from '../core/paths'
import { defineLimitlessTool, encodeToolFailure, type ToolExecutor } from '../plugin/tool-boundary'

export const DiagnosticsInput = Schema.Struct({
	workspace: Schema.optional(Schema.String),
	filePath: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
})
export type DiagnosticsInput = typeof DiagnosticsInput.Type

export const SkippedCheck = Schema.Struct({
	name: Schema.String,
	ok: Schema.Literal(false),
	skipped: Schema.Literal(true),
	reason: Schema.String,
})
export type SkippedCheck = typeof SkippedCheck.Type
export const ExecutedCheck = Schema.Struct({
	...CommandResult.fields,
	name: Schema.String,
	command: Schema.String,
	config: Schema.String,
})
export const DiagnosticCheck = Schema.Union([SkippedCheck, ExecutedCheck])
export type DiagnosticCheck = typeof DiagnosticCheck.Type
export const DiagnosticsStatus = Schema.Literals(['passed', 'failed', 'partial', 'skipped'])
const PassedDiagnosticsResult = Schema.Struct({
	ok: Schema.Literal(true),
	status: Schema.Literal('passed'),
	checks: Schema.Array(DiagnosticCheck),
})
const IncompleteDiagnosticsResult = Schema.Struct({
	ok: Schema.Literal(false),
	status: Schema.Literals(['failed', 'partial', 'skipped']),
	checks: Schema.Array(DiagnosticCheck),
})
export const DiagnosticsResult = Schema.Union([
	PassedDiagnosticsResult,
	IncompleteDiagnosticsResult,
])
export type DiagnosticsResult = typeof DiagnosticsResult.Type

function isSkippedCheck(check: DiagnosticCheck): check is SkippedCheck {
	return 'skipped' in check && check.skipped
}

export function summarizeDiagnostics(checks: ReadonlyArray<DiagnosticCheck>): DiagnosticsResult {
	const executedChecks = checks.filter((check) => !isSkippedCheck(check))
	if (executedChecks.some((check) => !check.ok)) {
		return DiagnosticsResult.make({ ok: false, status: 'failed', checks })
	}
	if (executedChecks.length === 0) {
		return DiagnosticsResult.make({ ok: false, status: 'skipped', checks })
	}
	if (checks.some(isSkippedCheck)) {
		return DiagnosticsResult.make({ ok: false, status: 'partial', checks })
	}
	return DiagnosticsResult.make({ ok: true, status: 'passed', checks })
}

function skippedCheck(name: string, reason: string): SkippedCheck {
	return SkippedCheck.make({
		name,
		ok: false,
		skipped: true,
		reason,
	})
}

export const lspDiagnostics = Effect.fn(function* lspDiagnostics(
	input: typeof DiagnosticsInput.Type,
) {
	const context = yield* ToolExecutionContext
	const cwd = workspaceRoot(input, context.projectRoot)
	const filePath = input.filePath ?? input.path ?? '.'
	const target = workspacePath(cwd, filePath)
	const checks: Array<DiagnosticCheck> = []

	const tsconfig = yield* findUp(['tsconfig.json', 'jsconfig.json'], target)
	if (tsconfig) {
		const configDirectory = path.dirname(tsconfig)
		const tsc = yield* findExecutable('tsc', configDirectory)
		const result = yield* runCommand(tsc, ['--noEmit', '--pretty', 'false', '-p', tsconfig], {
			cwd: configDirectory,
		})
		checks.push(
			ExecutedCheck.make({
				name: 'typescript',
				command: tsc,
				config: tsconfig,
				...result,
			}),
		)
	} else {
		checks.push(skippedCheck('typescript', 'No tsconfig.json or jsconfig.json found.'))
	}

	const biomeConfig = yield* findUp(['biome.json', 'biome.jsonc'], target)
	if (biomeConfig) {
		const configDirectory = path.dirname(biomeConfig)
		const biome = yield* findExecutable('biome', configDirectory)
		const result = yield* runCommand(biome, ['check', `--config-path=${biomeConfig}`, target], {
			cwd: configDirectory,
		})
		checks.push(
			ExecutedCheck.make({
				name: 'biome',
				command: biome,
				config: biomeConfig,
				...result,
			}),
		)
	} else {
		checks.push(skippedCheck('biome', 'No biome.json or biome.jsonc found.'))
	}

	return summarizeDiagnostics(checks)
})

export function diagnosticsTools(executeTool: ToolExecutor) {
	return {
		lsp_diagnostics: defineLimitlessTool({
			name: 'lsp_diagnostics',
			description: 'Run safe local diagnostics for TS/JS projects.',
			input: DiagnosticsInput,
			output: DiagnosticsResult,
			execute: (args, context) =>
				executeTool('lsp_diagnostics', args, context, lspDiagnostics, encodeToolFailure),
		}),
	}
}
