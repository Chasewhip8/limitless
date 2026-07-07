import path from 'node:path'
import type { ToolContext } from '@opencode-ai/plugin'
import { Effect } from 'effect'
import type {
	DiagnosticCheck,
	DiagnosticsInput,
	DiagnosticsResult,
	ExecutedCheck,
	SkippedCheck,
} from './lib/diagnostics'
import { findExecutable, findUp, runCommand, workspacePath, workspaceRoot } from './shared'

export {
	type DiagnosticCheck,
	DiagnosticsInput,
	type DiagnosticsResult,
	type DiagnosticsStatus,
	type ExecutedCheck,
	type SkippedCheck,
} from './lib/diagnostics'

function isSkippedCheck(check: DiagnosticCheck): check is SkippedCheck {
	return 'skipped' in check && check.skipped
}

export function summarizeDiagnostics(checks: ReadonlyArray<DiagnosticCheck>): DiagnosticsResult {
	const executedChecks = checks.filter((check) => !isSkippedCheck(check))
	if (executedChecks.some((check) => !check.ok)) return { ok: false, status: 'failed', checks }
	if (executedChecks.length === 0) return { ok: false, status: 'skipped', checks }
	if (checks.some(isSkippedCheck)) return { ok: false, status: 'partial', checks }
	return { ok: true, status: 'passed', checks }
}

function skippedCheck(name: string, reason: string): SkippedCheck {
	return {
		name,
		ok: false,
		skipped: true,
		reason,
	}
}

export const lspDiagnostics = Effect.fn(function* lspDiagnostics(
	input: typeof DiagnosticsInput.Type,
	context: ToolContext,
) {
	const cwd = workspaceRoot(input, context)
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
		checks.push({
			name: 'typescript',
			command: tsc,
			config: tsconfig,
			...result,
		} satisfies ExecutedCheck)
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
		checks.push({
			name: 'biome',
			command: biome,
			config: biomeConfig,
			...result,
		} satisfies ExecutedCheck)
	} else {
		checks.push(skippedCheck('biome', 'No biome.json or biome.jsonc found.'))
	}

	return summarizeDiagnostics(checks)
})
