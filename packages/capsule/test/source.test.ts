import { createHash } from 'node:crypto'
import {
	link,
	mkdir,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { Effect, type FileSystem, PlatformError, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { SourceStatus } from '../src/source/schema'
import { execute, sourceFixture } from './fixtures/source'

/** Fails the `occurrence`th manifest publication once. */
const failManifestRename =
	(occurrence: number) =>
	(fs: FileSystem.FileSystem): FileSystem.FileSystem => {
		let seen = 0
		return {
			...fs,
			rename: (from, to) =>
				Effect.gen(function* () {
					if (from.endsWith('.manifest.next') && ++seen === occurrence)
						return yield* PlatformError.systemError({
							_tag: 'PermissionDenied',
							module: 'FileSystem',
							method: 'rename',
						})
					return yield* fs.rename(from, to)
				}),
		}
	}

describe('source preparation', () => {
	it('clones the resolved fork branch and resumes Ready without resetting work or contacting remotes', async () => {
		const f = await sourceFixture()
		expect(await f.call((service) => service.inspect(f.request.id))).toEqual({
			_tag: 'Absent',
			id: f.request.id,
			directory: f.checkout,
		})
		const prepared = await f.call((service) => service.prepare(f.request))
		expect(prepared).toEqual({
			id: f.request.id,
			directory: f.checkout,
			branch: 'feature/fork',
			commit: f.headSha,
		})
		expect(await f.git(f.checkout, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature/fork')
		expect(await f.git(f.checkout, 'remote', 'get-url', 'origin')).toBe(f.source)
		expect(await f.git(f.checkout, 'remote', 'get-url', '--push', 'origin')).toBe(f.source)
		expect(await f.git(f.checkout, 'remote', 'get-url', 'upstream')).toBe(f.target)
		expect(
			await f.git(f.checkout, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'),
		).toBe('origin/feature/fork')
		expect(await f.git(f.checkout, 'rev-parse', '--is-shallow-repository')).toBe('false')
		expect(await f.git(f.checkout, 'rev-parse', 'origin/main')).toBe(f.initialSha)
		await f.git(f.checkout, 'cat-file', '-e', `${f.baseSha}^{commit}`)
		expect(
			await readFile(join(f.checkout, '.git', 'objects', 'info', 'alternates'), 'utf8').catch(
				() => '',
			),
		).toBe('')

		await f.git(f.checkout, 'config', 'user.name', 'Worker')
		await f.git(f.checkout, 'config', 'user.email', 'worker@example.invalid')
		await writeFile(join(f.checkout, 'tracked.txt'), 'unpublished commit\n')
		await f.git(f.checkout, 'add', 'tracked.txt')
		await f.git(f.checkout, 'commit', '-m', 'worker commit')
		const head = await f.git(f.checkout, 'rev-parse', 'HEAD')
		await writeFile(join(f.checkout, 'tracked.txt'), 'staged work\n')
		await f.git(f.checkout, 'add', 'tracked.txt')
		await writeFile(join(f.checkout, 'tracked.txt'), 'unstaged work\n')
		await writeFile(join(f.checkout, 'untracked.txt'), 'untracked work\n')
		const before = await f.git(f.checkout, 'status', '--porcelain=v1')
		await rm(f.source, { recursive: true })
		await rm(f.target, { recursive: true })
		const reordered = Object.fromEntries(Object.entries(f.request).reverse()) as typeof f.request
		expect(await f.call((service) => service.prepare(reordered))).toEqual(prepared)
		expect(await f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(head)
		expect(await f.git(f.checkout, 'status', '--porcelain=v1')).toBe(before)
		expect(await readdir(join(f.root, f.request.id))).not.toContain('staging')
	})

	it('resolves a mutable ref once and resumes interrupted configuration at that commit with staged work', async () => {
		const f = await sourceFixture({
			failCommand: { executable: 'git', argument: 'fetch', once: true },
		})
		const request = {
			id: f.request.id,
			repository: 'upstream/project',
			ref: 'main',
			branch: 'work',
			upstream: { repository: 'upstream/project', commits: [f.baseSha] },
		}
		expect(await f.error((service) => service.prepare(request))).toMatchObject({
			code: 'git_failed',
		})
		expect(await f.call((service) => service.inspect(f.request.id))).toMatchObject({
			_tag: 'Preparing',
			step: 'configure',
		})
		await writeFile(join(f.staging, 'tracked.txt'), 'interrupted preparation work\n')
		await f.git(f.target, 'update-ref', 'refs/heads/main', f.initialSha)
		expect(await f.call((service) => service.prepare(request))).toMatchObject({
			branch: 'work',
			commit: f.baseSha,
		})
		expect(await f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(f.baseSha)
		expect(await readFile(join(f.checkout, 'tracked.txt'), 'utf8')).toBe(
			'interrupted preparation work\n',
		)
		expect(
			await f.error((service) => service.prepare({ ...request, ref: 'feature/fork' })),
		).toMatchObject({ code: 'input_collision' })
	})

	it('leaves the source directory empty and adoptable when its first manifest publication fails', async () => {
		const f = await sourceFixture({ fileSystem: failManifestRename(1) })
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({
			code: 'io_failed',
		})
		expect(await readdir(join(f.root, f.request.id))).toEqual([])
		expect(await f.call((service) => service.prepare(f.request))).toMatchObject({
			commit: f.headSha,
		})
	})

	it('resumes a checkout interrupted before its clone step was recorded without resetting work', async () => {
		const f = await sourceFixture({ fileSystem: failManifestRename(2) })
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({
			code: 'io_failed',
		})
		expect(await f.call((service) => service.inspect(f.request.id))).toMatchObject({
			_tag: 'Preparing',
			step: 'clone',
		})
		await f.git(f.staging, 'config', 'user.name', 'Worker')
		await f.git(f.staging, 'config', 'user.email', 'worker@example.invalid')
		await writeFile(join(f.staging, 'tracked.txt'), 'staged work\n')
		await f.git(f.staging, 'add', 'tracked.txt')
		await f.git(f.staging, 'commit', '-m', 'unexpected commit')
		const commit = await f.git(f.staging, 'rev-parse', 'HEAD')
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({
			code: 'ownership_mismatch',
		})
		expect(await f.git(f.staging, 'rev-parse', 'refs/heads/feature/fork')).toBe(commit)

		await f.git(f.staging, 'reset', '--soft', f.headSha)
		await writeFile(join(f.staging, 'other.txt'), 'unstaged work\n')
		await writeFile(join(f.staging, 'untracked.txt'), 'untracked work\n')
		const dirty = await f.git(f.staging, 'status', '--porcelain=v1')
		expect(await f.call((service) => service.prepare(f.request))).toMatchObject({
			commit: f.headSha,
		})
		expect(await f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(f.headSha)
		expect(await f.git(f.checkout, 'status', '--porcelain=v1')).toBe(dirty)
		expect(await f.git(f.checkout, 'cat-file', '-t', commit)).toBe('commit')
	})

	it('checks out an interrupted clone only while it has no local work', async () => {
		const f = await sourceFixture({
			failCommand: { executable: 'git', argument: 'checkout', once: true },
		})
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({
			code: 'git_failed',
		})
		const branch = await f.git(f.staging, 'rev-parse', 'refs/heads/feature/fork')
		await writeFile(join(f.staging, 'tracked.txt'), 'user edit\n')
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({
			code: 'git_failed',
		})
		expect(await readFile(join(f.staging, 'tracked.txt'), 'utf8')).toBe('user edit\n')

		await mkdir(join(f.staging, '.git', 'info'), { recursive: true })
		await writeFile(join(f.staging, '.git', 'info', 'exclude'), 'tracked.txt\n')
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({
			code: 'git_failed',
		})
		expect(await readFile(join(f.staging, 'tracked.txt'), 'utf8')).toBe('user edit\n')
		expect(await f.git(f.staging, 'rev-parse', 'refs/heads/feature/fork')).toBe(branch)
		await expect(stat(join(f.staging, '.git', 'index'))).rejects.toMatchObject({ code: 'ENOENT' })
		expect(await f.call((service) => service.inspect(f.request.id))).toMatchObject({
			_tag: 'Preparing',
			step: 'clone',
		})
		await rm(join(f.staging, '.git', 'info', 'exclude'))

		await rm(join(f.staging, 'tracked.txt'))
		await f.git(f.staging, 'update-ref', 'refs/heads/feature/fork', f.initialSha)
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({
			code: 'ownership_mismatch',
		})
		expect(await f.git(f.staging, 'rev-parse', 'refs/heads/feature/fork')).toBe(f.initialSha)

		await f.git(f.staging, 'update-ref', 'refs/heads/feature/fork', f.headSha)
		await writeFile(join(f.staging, 'notes.txt'), 'kept\n')
		expect(await f.call((service) => service.prepare(f.request))).toMatchObject({
			commit: f.headSha,
		})
		expect(await readFile(join(f.checkout, 'notes.txt'), 'utf8')).toBe('kept\n')
	}, 15_000)

	it('tracks only a branch checked out under its own name, leaving work branches to an explicit push', async () => {
		const f = await sourceFixture()
		const tracking = (directory: string, branch: string) =>
			f
				.git(directory, 'config', '--local', '--get-regexp', `^branch\\.${branch}\\.`)
				.catch(() => '')

		const work = await f.call((service) =>
			service.prepare({
				id: 'work',
				repository: 'upstream/project',
				ref: 'main',
				branch: 'task-123',
			}),
		)
		expect(work.commit).toBe(f.baseSha)
		expect(await f.git(work.directory, 'symbolic-ref', 'HEAD')).toBe('refs/heads/task-123')
		expect(await tracking(work.directory, 'task-123')).toBe('')
		await f.git(work.directory, 'config', 'user.name', 'Worker')
		await f.git(work.directory, 'config', 'user.email', 'worker@example.invalid')
		await f.git(work.directory, 'commit', '--allow-empty', '-m', 'work')
		await expect(f.git(work.directory, 'push')).rejects.toThrow()
		expect(await f.git(f.target, 'rev-parse', 'refs/heads/main')).toBe(f.baseSha)

		const tagged = await f.call((service) =>
			service.prepare({ id: 'tagged', repository: 'upstream/project', ref: 'v1', branch: 'main' }),
		)
		expect(tagged.commit).toBe(f.initialSha)
		expect(await f.git(tagged.directory, 'rev-parse', 'refs/heads/main')).toBe(f.initialSha)
		expect(await tracking(tagged.directory, 'main')).toBe('')

		const pinned = await f.call((service) =>
			service.prepare({
				id: 'pinned',
				repository: 'contributor/project',
				ref: f.initialSha,
				branch: 'feature/fork',
				commit: f.initialSha,
			}),
		)
		expect(await f.git(pinned.directory, 'rev-parse', 'HEAD')).toBe(f.initialSha)
		expect(await tracking(pinned.directory, 'feature/fork')).toBe('')
		expect(await f.git(pinned.directory, 'status', '--porcelain=v1')).toBe('')

		await f.git(work.directory, 'config', 'branch.task-123.remote', 'origin')
		await f.git(work.directory, 'config', 'branch.task-123.merge', 'refs/heads/task-123')
		await writeFile(join(work.directory, 'untracked.txt'), 'kept\n')
		const head = await f.git(work.directory, 'rev-parse', 'HEAD')
		expect(
			await f.call((service) =>
				service.prepare({
					id: 'work',
					repository: 'upstream/project',
					ref: 'main',
					branch: 'task-123',
				}),
			),
		).toEqual(work)
		expect(await tracking(work.directory, 'task-123')).toBe(
			'branch.task-123.remote origin\nbranch.task-123.merge refs/heads/task-123',
		)
		expect(await f.git(work.directory, 'rev-parse', 'HEAD')).toBe(head)
		expect(await readFile(join(work.directory, 'untracked.txt'), 'utf8')).toBe('kept\n')
	})

	it('refuses unknown refs and unexpected commits before persisting a source', async () => {
		const f = await sourceFixture()
		expect(
			await f.error((service) => service.prepare({ ...f.request, ref: 'missing' })),
		).toMatchObject({ code: 'unknown_ref' })
		expect(
			await f.error((service) => service.prepare({ ...f.request, commit: f.initialSha })),
		).toMatchObject({ code: 'stale_ref' })
		await expect(stat(f.manifest)).rejects.toMatchObject({ code: 'ENOENT' })
		expect(await f.call((service) => service.prepare(f.request))).toMatchObject({
			commit: f.headSha,
		})
	})

	it('persists intent and rejects moved required remote refs before cloning or publishing', async () => {
		const f = await sourceFixture()
		await f.git(f.target, 'update-ref', 'refs/pull/7/head', f.initialSha)
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({
			code: 'stale_ref',
		})
		expect(await f.call((service) => service.inspect(f.request.id))).toMatchObject({
			_tag: 'Preparing',
			step: 'clone',
		})
		await expect(stat(f.staging)).rejects.toMatchObject({ code: 'ENOENT' })
		await f.git(f.target, 'update-ref', 'refs/pull/7/head', f.headSha)
		await f.git(f.source, 'update-ref', 'refs/heads/feature/fork', f.initialSha)
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({
			code: 'stale_ref',
		})
		await f.git(f.source, 'update-ref', 'refs/heads/feature/fork', f.headSha)
		expect(await f.call((service) => service.prepare(f.request))).toMatchObject({
			commit: f.headSha,
		})
	})

	it('rejects request collisions without changing the manifest or checkout', async () => {
		const f = await sourceFixture()
		await f.call((service) => service.prepare(f.request))
		const manifest = await readFile(f.manifest, 'utf8')
		for (const changed of [
			{ ...f.request, branch: 'other-branch' },
			{ ...f.request, remoteRefs: [] },
		])
			expect(await f.error((service) => service.prepare(changed))).toMatchObject({
				code: 'input_collision',
			})
		expect(
			await f.error((service) => service.archive({ ...f.request, ref: 'main' })),
		).toMatchObject({ code: 'input_collision' })
		expect(await readFile(f.manifest, 'utf8')).toBe(manifest)
		expect(await f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(f.headSha)
	})

	it('disables configured Git hooks during provisioning', async () => {
		const f = await sourceFixture()
		const hooks = join(f.directory, 'configured-hooks')
		await mkdir(hooks)
		await writeFile(join(hooks, 'post-checkout'), '#!/bin/sh\nexit 99\n', { mode: 0o755 })
		await writeFile(f.environment.GIT_CONFIG_GLOBAL ?? '', `[core]\n\thooksPath = ${hooks}\n`)
		expect(await f.call((service) => service.prepare(f.request))).toMatchObject({
			commit: f.headSha,
		})
	})

	it('rejects invalid requests before creating files', async () => {
		const f = await sourceFixture()
		for (const invalid of [
			{ ...f.request, id: '../outside' },
			{ ...f.request, repository: 'https://secret@github.com/owner/repo' },
			{ ...f.request, ref: 'branch/../../outside' },
			{ ...f.request, branch: '--upload-pack=bad' },
			{ ...f.request, commit: 'not-a-sha' },
			{ ...f.request, remoteRefs: [{ repository: 'a/b', ref: 'heads/main', commit: f.headSha }] },
		])
			expect(await f.error((service) => service.prepare(invalid))).toMatchObject({
				code: 'invalid_input',
			})
		expect(await f.error((service) => service.inspect('../outside'))).toMatchObject({
			code: 'invalid_input',
		})
		await expect(stat(f.root)).rejects.toMatchObject({ code: 'ENOENT' })
	})
})

describe('source path safety', () => {
	it('refuses source and checkout symlinks without traversing or deleting the target', async () => {
		const f = await sourceFixture()
		const outside = join(f.directory, 'unrelated')
		await mkdir(outside)
		await writeFile(join(outside, 'keep'), 'unrelated data')
		await mkdir(f.root)
		await symlink(outside, join(f.root, f.request.id))
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({
			code: 'unsafe_path',
		})
		await rm(join(f.root, f.request.id))
		await f.call((service) => service.prepare(f.request))
		await rename(f.checkout, `${f.checkout}.saved`)
		await symlink(outside, f.checkout)
		expect(await f.error((service) => service.archive(f.request))).toMatchObject({
			code: 'unsafe_path',
		})
		expect(await f.error((service) => service.release(f.request.id))).toMatchObject({
			code: 'unsafe_path',
		})
		expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('unrelated data')
	})

	it('refuses control and Git-metadata symlinks while preserving recoverable files', async () => {
		const f = await sourceFixture()
		await f.call((service) => service.prepare(f.request))
		const savedManifest = `${f.manifest}.saved`
		await rename(f.manifest, savedManifest)
		await symlink(savedManifest, f.manifest)
		expect(await f.error((service) => service.inspect(f.request.id))).toMatchObject({
			code: 'unsafe_path',
		})
		await rm(f.manifest)
		await rename(savedManifest, f.manifest)
		const gitConfig = join(f.checkout, '.git', 'config')
		const externalConfig = join(f.directory, 'external-config')
		await rename(gitConfig, externalConfig)
		const unchangedConfig = await readFile(externalConfig, 'utf8')
		await symlink(externalConfig, gitConfig)
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({
			code: 'unsafe_path',
		})
		expect(await readFile(externalConfig, 'utf8')).toBe(unchangedConfig)
		await rm(gitConfig)
		await rename(externalConfig, gitConfig)
		await rename(join(f.checkout, '.git'), join(f.directory, 'saved.git'))
		await symlink(join(f.directory, 'saved.git'), join(f.checkout, '.git'))
		expect(await f.error((service) => service.archive(f.request))).toMatchObject({
			code: 'unsafe_path',
		})
		expect(await readFile(join(f.checkout, 'tracked.txt'), 'utf8')).toBe('initial\n')
	})

	it('refuses directories without an ownership manifest and invalid manifests', async () => {
		const f = await sourceFixture()
		await mkdir(join(f.root, f.request.id), { recursive: true, mode: 0o700 })
		expect(await f.error((service) => service.archive(f.request))).toMatchObject({
			code: 'ownership_mismatch',
		})
		const unowned = join(f.root, f.request.id, 'unrelated.txt')
		await writeFile(unowned, 'unowned data\n')
		expect(await f.error((service) => service.release(f.request.id))).toMatchObject({
			code: 'illegal_transition',
		})
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({
			code: 'ownership_mismatch',
		})
		expect(await readFile(unowned, 'utf8')).toBe('unowned data\n')
		await writeFile(f.manifest, 'invalid manifest')
		expect(await f.error((service) => service.archive(f.request))).toMatchObject({
			code: 'invalid_manifest',
		})
		expect(await readFile(f.manifest, 'utf8')).toBe('invalid manifest')
		const foreign = JSON.stringify({
			owner: 'limitless-workspace-v1',
			request: f.request,
			status: { _tag: 'Ready', id: f.request.id, directory: f.checkout },
		})
		await writeFile(f.manifest, foreign)
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({
			code: 'invalid_manifest',
		})
		expect(await f.error((service) => service.inspect(f.request.id))).toMatchObject({
			code: 'invalid_manifest',
		})
		expect(await readFile(f.manifest, 'utf8')).toBe(foreign)
	})

	it('refuses hard-linked control files instead of overwriting unrelated data', async () => {
		const f = await sourceFixture()
		await f.call((service) => service.prepare(f.request))
		const unrelated = join(f.directory, 'unrelated-data')
		await writeFile(unrelated, 'keep unrelated content\n')
		await link(unrelated, join(f.root, '.locks', `${f.request.id}.manifest.next`))
		expect(await f.error((service) => service.archive(f.request))).toMatchObject({
			code: 'unsafe_path',
		})
		expect(await readFile(unrelated, 'utf8')).toBe('keep unrelated content\n')
		expect(await f.call((service) => service.inspect(f.request.id))).toMatchObject({
			_tag: 'Ready',
		})
	})
})

describe('source retention', () => {
	it('archives a never-created source without cloning and fences later preparation after release', async () => {
		const f = await sourceFixture()
		await rm(f.source, { recursive: true })
		await rm(f.target, { recursive: true })
		const archived = await f.call((service) => service.archive(f.request))
		if (archived._tag !== 'Archived') throw new Error('Expected Archived')
		expect((await execute('tar', ['--list', '--file', archived.archive.path])).stdout).toBe('')
		expect((await readdir(join(f.root, f.request.id))).sort()).toEqual([
			'checkout.tar',
			'manifest.json',
		])
		expect(await f.call((service) => service.archive(f.request))).toEqual(archived)
		const released = await f.call((service) => service.release(f.request.id))
		expect(released).toEqual({ ...archived, _tag: 'Released' })
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({
			code: 'illegal_transition',
		})
		expect(await f.call((service) => service.inspect(f.request.id))).toEqual(released)
	})

	it('archives and releases failed provisioning, including an incomplete owned clone', async () => {
		const f = await sourceFixture({
			failCommand: { executable: 'git', argument: 'clone', once: false },
		})
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({
			code: 'git_failed',
		})
		await mkdir(join(f.staging, '.git', 'objects'), { recursive: true })
		await writeFile(join(f.staging, '.git', 'objects', 'incomplete.pack'), 'partial fetch bytes\n')
		await writeFile(join(f.staging, 'recover.txt'), 'not published\n')
		const archived = await f.call((service) => service.archive(f.request))
		if (archived._tag !== 'Archived') throw new Error('Expected Archived')
		const restored = join(f.directory, 'partial-restore')
		await mkdir(restored)
		await execute('tar', ['--extract', '--file', archived.archive.path, '--directory', restored])
		expect(
			await readFile(join(restored, 'staging', '.git', 'objects', 'incomplete.pack'), 'utf8'),
		).toBe('partial fetch bytes\n')
		expect(await f.call((service) => service.release(f.request.id))).toMatchObject({
			_tag: 'Released',
		})
		await expect(stat(f.staging)).rejects.toMatchObject({ code: 'ENOENT' })
	})

	it('retains full Git history, index, dirty, ignored files, and symlinks after release', async () => {
		const f = await sourceFixture()
		await f.call((service) => service.prepare(f.request))
		await f.git(f.checkout, 'config', 'user.name', 'Worker')
		await f.git(f.checkout, 'config', 'user.email', 'worker@example.invalid')
		await writeFile(join(f.checkout, 'tracked.txt'), 'unpublished commit\n')
		await f.git(f.checkout, 'add', 'tracked.txt')
		await f.git(f.checkout, 'commit', '-m', 'unpublished worker history')
		const unpublished = await f.git(f.checkout, 'rev-parse', 'HEAD')
		const tree = await f.git(f.checkout, 'rev-parse', 'HEAD^{tree}')
		const dangling = await f.git(
			f.checkout,
			'commit-tree',
			tree,
			'-p',
			f.initialSha,
			'-m',
			'dangling',
		)
		await writeFile(join(f.checkout, 'tracked.txt'), 'staged\n')
		await f.git(f.checkout, 'add', 'tracked.txt')
		await writeFile(join(f.checkout, 'tracked.txt'), 'unstaged after staging\n')
		await writeFile(join(f.checkout, 'untracked.txt'), 'untracked\n')
		await writeFile(join(f.checkout, '.gitignore'), 'ignored.bin\n')
		await writeFile(join(f.checkout, 'ignored.bin'), 'ignored but recoverable\n')
		const outside = join(f.directory, 'outside.txt')
		await writeFile(outside, 'do not follow\n')
		await symlink(outside, join(f.checkout, 'outside-link'))
		const staged = await f.git(f.checkout, 'diff', '--cached')
		const unstaged = await f.git(f.checkout, 'diff')
		const archived = await f.call((service) => service.archive(f.request))
		if (archived._tag !== 'Archived') throw new Error('Expected Archived')
		expect(Schema.is(SourceStatus)(archived)).toBe(true)
		const archiveBytes = await readFile(archived.archive.path)
		expect(archived.archive.bytes).toBe(archiveBytes.length)
		expect(archived.archive.sha256).toBe(createHash('sha256').update(archiveBytes).digest('hex'))
		const restore = join(f.directory, 'restore')
		await mkdir(restore)
		await execute('tar', ['--extract', '--file', archived.archive.path, '--directory', restore])
		const recovered = join(restore, 'checkout')
		expect(await f.git(recovered, 'rev-parse', 'HEAD')).toBe(unpublished)
		expect(await f.git(recovered, 'cat-file', '-t', dangling)).toBe('commit')
		expect(await f.git(recovered, 'diff', '--cached')).toBe(staged)
		expect(await f.git(recovered, 'diff')).toBe(unstaged)
		expect(await readFile(join(recovered, 'untracked.txt'), 'utf8')).toBe('untracked\n')
		expect(await readFile(join(recovered, 'ignored.bin'), 'utf8')).toBe('ignored but recoverable\n')
		expect(await readlink(join(recovered, 'outside-link'))).toBe(outside)
		await f.git(recovered, 'fsck', '--full')
		const released = await f.call((service) => service.release(f.request.id))
		expect(released).toEqual({ ...archived, _tag: 'Released' })
		await expect(stat(f.checkout)).rejects.toMatchObject({ code: 'ENOENT' })
		expect(await readFile(archived.archive.path)).toEqual(archiveBytes)
		expect(await readFile(outside, 'utf8')).toBe('do not follow\n')
		expect(await f.call((service) => service.release(f.request.id))).toEqual(released)
	}, 20_000)

	it('retains archiving intent, checkout, and partial archive when verification fails, then resumes', async () => {
		const f = await sourceFixture({
			failCommand: { executable: 'tar', argument: '--compare', once: true },
		})
		await f.call((service) => service.prepare(f.request))
		await writeFile(join(f.checkout, 'precious.txt'), 'keep me\n')
		expect(await f.error((service) => service.archive(f.request))).toMatchObject({
			code: 'archive_failed',
		})
		expect(await f.call((service) => service.inspect(f.request.id))).toMatchObject({
			_tag: 'Archiving',
		})
		expect(await readFile(join(f.checkout, 'precious.txt'), 'utf8')).toBe('keep me\n')
		expect((await stat(join(f.root, f.request.id, 'checkout.tar.partial'))).size).toBeGreaterThan(0)
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({
			code: 'illegal_transition',
		})
		expect(await f.call((service) => service.archive(f.request))).toMatchObject({
			_tag: 'Archived',
		})
	})

	it('does not release a modified archive or newly added post-archive work', async () => {
		const f = await sourceFixture()
		await f.call((service) => service.prepare(f.request))
		expect(await f.error((service) => service.release(f.request.id))).toMatchObject({
			code: 'illegal_transition',
		})
		const archived = await f.call((service) => service.archive(f.request))
		if (archived._tag !== 'Archived') throw new Error('Expected Archived')
		await writeFile(join(f.checkout, 'late-untracked.txt'), 'late work\n')
		expect(await f.error((service) => service.release(f.request.id))).toMatchObject({
			code: 'archive_changed',
		})
		expect(await readFile(join(f.checkout, 'late-untracked.txt'), 'utf8')).toBe('late work\n')
		await writeFile(archived.archive.path, 'corrupted archive')
		expect(await f.error((service) => service.release(f.request.id))).toMatchObject({
			code: 'archive_changed',
		})
		expect(await f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(f.headSha)
	})

	it('refuses entries tar cannot preserve rather than silently deleting them on release', async () => {
		const f = await sourceFixture()
		await f.call((service) => service.prepare(f.request))
		const socket = join(f.checkout, 's')
		const server = createServer()
		await new Promise<void>((resolve) => server.listen(socket, resolve))
		try {
			expect(await f.error((service) => service.archive(f.request))).toMatchObject({
				code: 'archive_failed',
			})
			expect((await stat(socket)).isSocket()).toBe(true)
			expect(await f.error((service) => service.release(f.request.id))).toMatchObject({
				code: 'illegal_transition',
			})
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			)
		}
	})

	it('resumes a partially deleted checkout from durable releasing intent without losing its archive', async () => {
		let failRemoval = true
		const f = await sourceFixture({
			fileSystem: (fs) => ({
				...fs,
				remove: (file, options) =>
					Effect.gen(function* () {
						if (file.endsWith('/checkout') && failRemoval) {
							failRemoval = false
							yield* fs.remove(join(file, '.git'), { recursive: true })
							return yield* PlatformError.systemError({
								_tag: 'PermissionDenied',
								module: 'FileSystem',
								method: 'remove',
							})
						}
						return yield* fs.remove(file, options)
					}),
			}),
		})
		await f.call((service) => service.prepare(f.request))
		await writeFile(join(f.checkout, 'precious.txt'), 'recover me\n')
		const archived = await f.call((service) => service.archive(f.request))
		if (archived._tag !== 'Archived') throw new Error('Expected Archived')
		const archiveBytes = await readFile(archived.archive.path)
		expect(await f.error((service) => service.release(f.request.id))).toMatchObject({
			code: 'io_failed',
		})
		expect(await f.call((service) => service.inspect(f.request.id))).toMatchObject({
			_tag: 'Releasing',
		})
		expect(await readFile(join(f.checkout, 'precious.txt'), 'utf8')).toBe('recover me\n')
		expect(await f.call((service) => service.release(f.request.id))).toMatchObject({
			_tag: 'Released',
		})
		expect(await readFile(archived.archive.path)).toEqual(archiveBytes)
	})
})
