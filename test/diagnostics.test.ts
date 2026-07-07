import { describe, expect, test } from 'vitest'
import { summarizeDiagnostics } from '../packages/limitless/diagnostics'
import type { DiagnosticCheck } from '../packages/limitless/lib/diagnostics'

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

describe('summarizeDiagnostics', () => {
	test('all passed => { ok: true, status: "passed" }', () => {
		expect(summarizeDiagnostics([passedCheck('typescript'), passedCheck('biome')])).toMatchObject({
			ok: true,
			status: 'passed',
		})
	})

	test('pass + skipped => { ok: false, status: "partial" }', () => {
		expect(summarizeDiagnostics([passedCheck('typescript'), skippedCheck('biome')])).toMatchObject({
			ok: false,
			status: 'partial',
		})
	})

	test('fail + skipped => { ok: false, status: "failed" }', () => {
		expect(summarizeDiagnostics([failedCheck('typescript'), skippedCheck('biome')])).toMatchObject({
			ok: false,
			status: 'failed',
		})
	})

	test('all skipped => { ok: false, status: "skipped" }', () => {
		expect(summarizeDiagnostics([skippedCheck('typescript'), skippedCheck('biome')])).toMatchObject(
			{
				ok: false,
				status: 'skipped',
			},
		)
	})
})
