import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { runCommand } from '../shared'

describe('runCommand', () => {
	test('forwards AbortSignal cancellation to the child process', async () => {
		const abort = new AbortController()
		abort.abort()
		const result = await Effect.runPromise(
			runCommand(process.execPath, ['--version'], { signal: abort.signal }),
		)

		expect(result.ok).toBe(false)
		expect(result.exitCode).toBeNull()
	})
})
