import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { writeJsonFile } from '../tools/artifacts/filesystem'

async function withWorkspace<T>(body: (workspace: string) => Promise<T>): Promise<T> {
	const workspace = await mkdtemp(join(tmpdir(), 'limitless-fs-'))
	try {
		return await body(workspace)
	} finally {
		await rm(workspace, { recursive: true, force: true })
	}
}

describe('writeJsonFile', () => {
	test('rejects values that are not valid JSON', async () => {
		await withWorkspace(async (workspace) => {
			await expect(
				Effect.runPromise(writeJsonFile(join(workspace, 'invalid.json'), undefined, 'test')),
			).rejects.toMatchObject({ _tag: 'ToolOperationError' })
		})
	})
})
