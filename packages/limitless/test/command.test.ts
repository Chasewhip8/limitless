import { Effect, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { CommandResult, runCommand } from '../core/command'

describe('runCommand', () => {
	test('forwards AbortSignal cancellation to the child process', async () => {
		const abort = new AbortController()
		abort.abort()
		const result = await Effect.runPromise(
			runCommand(process.execPath, ['--version'], { signal: abort.signal }).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(CommandResult)),
			),
		)

		expect(result.ok).toBe(false)
		expect(result.exitCode).toBeNull()
	})
})
