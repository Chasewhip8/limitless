import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'
import { ToolExecutionContext } from '../core/execution'
import {
	type DiagnosticCheck,
	DiagnosticsResult,
	lspDiagnostics,
	summarizeDiagnostics,
} from '../tools/diagnostics'
import { testToolExecution } from './execution'

const tempDirectories: Array<string> = []

afterEach(async () => {
	await Promise.all(
		tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	)
})

async function diagnosticsWorktree(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), 'limitless-diagnostics-'))
	tempDirectories.push(root)
	await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true })
	await mkdir(path.join(root, 'src'))
	await writeFile(path.join(root, 'tsconfig.json'), '{}\n')
	await writeFile(path.join(root, 'biome.json'), '{}\n')
	await writeFile(path.join(root, 'src', 'index.ts'), 'export {}\n')
	for (const name of ['tsc', 'biome']) {
		const binary = path.join(root, 'node_modules', '.bin', name)
		await writeFile(
			binary,
			'#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n',
		)
		await chmod(binary, 0o755)
	}
	return root
}

function summarize(checks: ReadonlyArray<DiagnosticCheck>) {
	return DiagnosticsResult.make(summarizeDiagnostics(checks))
}

function passedCheck(name: string): DiagnosticCheck {
	return {
		name,
		command: name,
		config: `${name}.json`,
		ok: true,
		exitCode: 0,
		stdout: '',
		stderr: '',
	}
}

function failedCheck(name: string): DiagnosticCheck {
	return {
		name,
		command: name,
		config: `${name}.json`,
		ok: false,
		exitCode: 1,
		stdout: '',
		stderr: 'failed',
	}
}

function skippedCheck(name: string): DiagnosticCheck {
	return {
		name,
		ok: false,
		skipped: true,
		reason: 'not configured',
	}
}

describe('lspDiagnostics', () => {
	test('discovers project configs and executes local TypeScript and Biome binaries', async () => {
		const root = await diagnosticsWorktree()
		const target = path.join(root, 'src', 'index.ts')
		const result = await Effect.runPromise(
			lspDiagnostics({ filePath: 'src/index.ts' }).pipe(
				Effect.provideService(ToolExecutionContext, testToolExecution(root)),
			),
		)

		expect(result).toMatchObject({ ok: true, status: 'passed' })
		const typescript = result.checks.find((check) => check.name === 'typescript')
		const biome = result.checks.find((check) => check.name === 'biome')
		if (typescript === undefined || 'skipped' in typescript) {
			throw new Error('Expected TypeScript diagnostics to execute')
		}
		if (biome === undefined || 'skipped' in biome) {
			throw new Error('Expected Biome diagnostics to execute')
		}
		expect(typescript.command).toBe(path.join(root, 'node_modules', '.bin', 'tsc'))
		expect(JSON.parse(typescript.stdout)).toEqual([
			'--noEmit',
			'--pretty',
			'false',
			'-p',
			path.join(root, 'tsconfig.json'),
		])
		expect(biome.command).toBe(path.join(root, 'node_modules', '.bin', 'biome'))
		expect(JSON.parse(biome.stdout)).toEqual([
			'check',
			`--config-path=${path.join(root, 'biome.json')}`,
			target,
		])
	})
})

describe('summarizeDiagnostics', () => {
	test('all passed => { ok: true, status: "passed" }', () => {
		expect(summarize([passedCheck('typescript'), passedCheck('biome')])).toMatchObject({
			ok: true,
			status: 'passed',
		})
	})

	test('pass + skipped => { ok: false, status: "partial" }', () => {
		expect(summarize([passedCheck('typescript'), skippedCheck('biome')])).toMatchObject({
			ok: false,
			status: 'partial',
		})
	})

	test('fail + skipped => { ok: false, status: "failed" }', () => {
		expect(summarize([failedCheck('typescript'), skippedCheck('biome')])).toMatchObject({
			ok: false,
			status: 'failed',
		})
	})

	test('all skipped => { ok: false, status: "skipped" }', () => {
		expect(summarize([skippedCheck('typescript'), skippedCheck('biome')])).toMatchObject({
			ok: false,
			status: 'skipped',
		})
	})
})
