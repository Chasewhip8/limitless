import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { copyDirectoryContents, writeJsonFile } from '../tools/artifacts/filesystem'

async function withWorkspace<T>(body: (workspace: string) => Promise<T>): Promise<T> {
	const workspace = await mkdtemp(join(tmpdir(), 'limitless-fs-'))
	try {
		return await body(workspace)
	} finally {
		await rm(workspace, { recursive: true, force: true })
	}
}

describe('copyDirectoryContents', () => {
	test('copies read-only source files into writable destination files', async () => {
		await withWorkspace(async (workspace) => {
			const source = join(workspace, 'source')
			const destination = join(workspace, 'destination')
			await mkdir(source)
			await mkdir(destination)
			const sourceFile = join(source, 'main.typ')
			await writeFile(sourceFile, 'template')
			await chmod(sourceFile, 0o444)

			await Effect.runPromise(copyDirectoryContents(source, destination, 'artifact_create'))

			const destinationFile = join(destination, 'main.typ')
			expect((await stat(destinationFile)).mode & 0o200).toBe(0o200)
			await writeFile(destinationFile, 'edited')
			await expect(readFile(destinationFile, 'utf8')).resolves.toBe('edited')
		})
	})
})

describe('writeJsonFile', () => {
	test('rejects values that are not valid JSON', async () => {
		await withWorkspace(async (workspace) => {
			await expect(
				Effect.runPromise(writeJsonFile(join(workspace, 'invalid.json'), undefined, 'test')),
			).rejects.toMatchObject({ _tag: 'ToolOperationError' })
		})
	})
})
