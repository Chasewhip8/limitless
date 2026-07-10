import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { ToolContext } from '@opencode-ai/plugin'
import { Effect } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
	assertAllowedRepo,
	cloneDirectoryName,
	type GitHubCloneOptions,
	githubClone as githubCloneEffect,
	normalizeGitHubPluginConfig,
	normalizeRepo,
	resolveGitHubSubmoduleUrl,
} from '../github'

const execFileAsync = promisify(execFile)
const tokenEnv = 'LIMITLESS_TEST_GITHUB_TOKEN'
const unrestrictedConfig = { tokenEnv, allowedRepos: [], allowUnrestrictedRepos: true }
const tempDirectories: Array<string> = []

type RepositoryFixture = {
	readonly repo: string
	readonly source: string
	readonly bare: string
}

const gitIdentity = {
	...process.env,
	GIT_AUTHOR_EMAIL: 'limitless@example.test',
	GIT_AUTHOR_NAME: 'Limitless Test',
	GIT_COMMITTER_EMAIL: 'limitless@example.test',
	GIT_COMMITTER_NAME: 'Limitless Test',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
}

async function git(cwd: string, args: ReadonlyArray<string>): Promise<string> {
	const result = await execFileAsync('git', [...args], {
		cwd,
		env: gitIdentity,
		encoding: 'utf8',
	})
	return result.stdout.trim()
}

async function testRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), 'limitless-github-clone-'))
	tempDirectories.push(root)
	return root
}

async function initializeRepository(root: string, repo: string): Promise<RepositoryFixture> {
	const safeName = repo.replace('/', '-')
	const source = path.join(root, 'sources', safeName)
	const bare = path.join(root, 'remotes', `${safeName}.git`)
	await mkdir(source, { recursive: true })
	await git(source, ['init', '--initial-branch=main'])
	await writeFile(path.join(source, 'README.md'), `${repo}\n`)
	await commitAll(source, 'initial')
	return { repo, source, bare }
}

async function commitAll(source: string, message: string): Promise<string> {
	await git(source, ['add', '--all'])
	await git(source, ['commit', '--message', message])
	return git(source, ['rev-parse', 'HEAD'])
}

async function publishRepository(root: string, fixture: RepositoryFixture): Promise<void> {
	await mkdir(path.dirname(fixture.bare), { recursive: true })
	await git(root, ['clone', '--bare', fixture.source, fixture.bare])
}

async function pushMain(fixture: RepositoryFixture): Promise<void> {
	await git(fixture.source, ['push', fixture.bare, 'HEAD:refs/heads/main'])
}

async function addSubmodule(
	parent: RepositoryFixture,
	child: RepositoryFixture,
	submodulePath: string,
): Promise<void> {
	await git(parent.source, [
		'-c',
		'protocol.file.allow=always',
		'submodule',
		'add',
		child.bare,
		submodulePath,
	])
	const key = await git(parent.source, [
		'config',
		'--file',
		'.gitmodules',
		'--name-only',
		'--get-regexp',
		'^submodule\\..*\\.path$',
	])
	await git(parent.source, [
		'config',
		'--file',
		'.gitmodules',
		key.replace(/\.path$/u, '.url'),
		`https://github.com/${child.repo}.git`,
	])
	await commitAll(parent.source, `add ${child.repo}`)
}

function cloneOptions(fixtures: ReadonlyArray<RepositoryFixture>): GitHubCloneOptions {
	return {
		gitBin: 'git',
		gitConfig: [
			{ key: 'protocol.file.allow', value: 'always' },
			...fixtures.map((fixture) => ({
				key: `url.${pathToFileURL(fixture.bare).href}.insteadOf`,
				value: `https://github.com/${fixture.repo}.git`,
			})),
		],
	}
}

async function createWorktree(root: string): Promise<string> {
	const worktree = path.join(root, 'worktree')
	await mkdir(worktree)
	return worktree
}

function toolContext(worktree: string, signal = new AbortController().signal): ToolContext {
	return {
		sessionID: 'session',
		messageID: 'message',
		agent: 'limitless',
		directory: worktree,
		worktree,
		abort: signal,
		metadata: () => undefined,
		ask: () => {
			throw new Error('ask is not used by githubClone tests')
		},
	}
}

function githubClone(
	config: Parameters<typeof githubCloneEffect>[0],
	input: Parameters<typeof githubCloneEffect>[1],
	context: Parameters<typeof githubCloneEffect>[2],
	options: GitHubCloneOptions = {},
) {
	return Effect.runPromise(githubCloneEffect(config, input, context, options))
}

afterEach(async () => {
	delete process.env[tokenEnv]
	await Promise.all(
		tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	)
})

describe('GitHub configuration and naming', () => {
	test('normalizes config without exposing token values', () => {
		expect(
			normalizeGitHubPluginConfig({
				github: {
					enable: true,
					tokenEnv: 'CUSTOM_TOKEN',
					tokenFile: ' /run/agenix/github-token ',
					allowedRepos: ['Owner/Repo', 'owner/repo'],
				},
			}),
		).toEqual({
			enabled: true,
			config: {
				tokenEnv: 'CUSTOM_TOKEN',
				tokenFile: '/run/agenix/github-token',
				allowedRepos: ['owner/repo'],
				allowUnrestrictedRepos: false,
			},
		})
	})

	test('is disabled without warnings when config is absent', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		expect(normalizeGitHubPluginConfig(undefined).enabled).toBe(false)
		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})

	test('disables malformed config and warns once', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		expect(
			normalizeGitHubPluginConfig({ github: { enable: true, allowedRepos: ['owner/repo', 42] } })
				.enabled,
		).toBe(false)
		expect(warn).toHaveBeenCalledTimes(1)
		warn.mockRestore()
	})

	test('validates repositories and allowlists', () => {
		expect(normalizeRepo('Owner/Repo')).toBe('owner/repo')
		expect(assertAllowedRepo('Owner/Repo', ['owner/repo'])).toBe('owner/repo')
		expect(() => normalizeRepo('../owner/repo')).toThrow(/Invalid GitHub repository/u)
		expect(() => assertAllowedRepo('other/repo', ['owner/repo'])).toThrow(/allowlist/u)
	})

	test('uses provider-prefixed default paths and collision-resistant ref paths', () => {
		expect(cloneDirectoryName('Owner/Repo')).toBe('github-owner-repo')
		const branch = cloneDirectoryName('Owner/Repo', 'feature/source-search')
		expect(branch).toMatch(/^github-owner-repo-feature-source-search-[0-9a-f]{12}$/u)
		expect(branch).toBe(cloneDirectoryName('owner/repo', 'feature/source-search'))
		expect(branch).not.toBe(cloneDirectoryName('owner/repo', 'feature/source_search'))
	})
})

describe('GitHub clone lifecycle', () => {
	test('creates a shallow default-branch checkout and refreshes it', async () => {
		const root = await testRoot()
		const fixture = await initializeRepository(root, 'owner/repo')
		await publishRepository(root, fixture)
		const worktree = await createWorktree(root)
		const options = cloneOptions([fixture])

		const first = await githubClone(
			unrestrictedConfig,
			{ repo: fixture.repo },
			toolContext(worktree),
			options,
		)
		expect(first.ok).toBe(true)
		if (!first.ok) throw new Error(first.error.message)
		expect(first.state).toBe('created')
		expect(first.relativePath).toBe('.limitless/repos/github-owner-repo')
		expect(first.absolutePath).toBe(path.join(worktree, first.relativePath))
		expect(await git(first.absolutePath, ['rev-parse', '--is-shallow-repository'])).toBe('true')

		await writeFile(path.join(fixture.source, 'README.md'), 'updated\n')
		const updatedCommit = await commitAll(fixture.source, 'update')
		await pushMain(fixture)
		const second = await githubClone(
			unrestrictedConfig,
			{ repo: fixture.repo },
			toolContext(worktree),
			options,
		)
		if (!second.ok) throw new Error(`${second.error.code}: ${second.error.message}`)
		expect(second.ok).toBe(true)
		expect(second.state).toBe('updated')
		expect(second.resolvedCommit).toBe(updatedCommit)
		expect(await readFile(path.join(second.absolutePath, 'README.md'), 'utf8')).toBe('updated\n')
	})

	test('ref checkouts use separate deterministic directories', async () => {
		const root = await testRoot()
		const fixture = await initializeRepository(root, 'owner/repo')
		await git(fixture.source, ['tag', 'v1.0.0'])
		await publishRepository(root, fixture)
		const worktree = await createWorktree(root)

		const result = await githubClone(
			unrestrictedConfig,
			{ repo: fixture.repo, ref: 'v1.0.0' },
			toolContext(worktree),
			cloneOptions([fixture]),
		)
		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error(result.error.message)
		expect(result.requestedRef).toBe('v1.0.0')
		expect(result.relativePath).toMatch(/^\.limitless\/repos\/github-owner-repo-v1-0-0-/u)
	})

	test('serializes concurrent calls for the same managed checkout', async () => {
		const root = await testRoot()
		const fixture = await initializeRepository(root, 'owner/repo')
		await publishRepository(root, fixture)
		const worktree = await createWorktree(root)
		const options = cloneOptions([fixture])

		const results = await Promise.all([
			githubClone(unrestrictedConfig, { repo: fixture.repo }, toolContext(worktree), options),
			githubClone(unrestrictedConfig, { repo: fixture.repo }, toolContext(worktree), options),
		])
		for (const result of results) {
			if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
		}
		expect(results.map((result) => (result.ok ? result.state : 'failed')).sort()).toEqual([
			'created',
			'updated',
		])
	})

	test('refuses to refresh dirty managed checkouts', async () => {
		const root = await testRoot()
		const fixture = await initializeRepository(root, 'owner/repo')
		await publishRepository(root, fixture)
		const worktree = await createWorktree(root)
		const options = cloneOptions([fixture])
		const first = await githubClone(
			unrestrictedConfig,
			{ repo: fixture.repo },
			toolContext(worktree),
			options,
		)
		if (!first.ok) throw new Error(first.error.message)
		await writeFile(path.join(first.absolutePath, 'untracked.txt'), 'do not overwrite\n')

		const result = await githubClone(
			unrestrictedConfig,
			{ repo: fixture.repo },
			toolContext(worktree),
			options,
		)
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error('Expected dirty checkout failure')
		expect(result.error.code).toBe('DIRTY_CHECKOUT')
		expect(await readFile(path.join(first.absolutePath, 'untracked.txt'), 'utf8')).toBe(
			'do not overwrite\n',
		)
	})

	test('rejects an existing checkout with a different origin', async () => {
		const root = await testRoot()
		const fixture = await initializeRepository(root, 'owner/repo')
		await publishRepository(root, fixture)
		const worktree = await createWorktree(root)
		const options = cloneOptions([fixture])
		const first = await githubClone(
			unrestrictedConfig,
			{ repo: fixture.repo },
			toolContext(worktree),
			options,
		)
		if (!first.ok) throw new Error(first.error.message)
		await git(first.absolutePath, [
			'remote',
			'set-url',
			'origin',
			'https://github.com/other/repo.git',
		])

		const result = await githubClone(
			unrestrictedConfig,
			{ repo: fixture.repo },
			toolContext(worktree),
			options,
		)
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error('Expected origin mismatch')
		expect(result.error.code).toBe('CHECKOUT_IDENTITY_MISMATCH')
	})

	test('requires an allowlist unless unrestricted access is explicit', async () => {
		const root = await testRoot()
		const worktree = await createWorktree(root)
		const result = await githubClone(
			{ tokenEnv, allowedRepos: [], allowUnrestrictedRepos: false },
			{ repo: 'owner/repo' },
			toolContext(worktree),
			{ gitBin: 'git' },
		)
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error('Expected repository policy failure')
		expect(result.error.code).toBe('REPOSITORY_NOT_ALLOWED')
		expect(await readdir(worktree)).toEqual([])
	})

	test('propagates cancellation before starting Git', async () => {
		const root = await testRoot()
		const worktree = await createWorktree(root)
		const abort = new AbortController()
		abort.abort()
		const result = await githubClone(
			unrestrictedConfig,
			{ repo: 'owner/repo' },
			toolContext(worktree, abort.signal),
			{ gitBin: 'git' },
		)
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error('Expected aborted clone')
		expect(result.error.code).toBe('ABORTED')
	})

	test('sanitizes token-bearing Git environment and removes failed staging checkouts', async () => {
		const root = await testRoot()
		const worktree = await createWorktree(root)
		const fakeGit = path.join(root, 'fake-git.mjs')
		await writeFile(
			fakeGit,
			`#!/usr/bin/env node\nprocess.stderr.write(JSON.stringify({ argv: process.argv.slice(2), env: process.env })); process.exit(2)\n`,
		)
		await chmod(fakeGit, 0o755)
		process.env[tokenEnv] = 'secret-token'

		const result = await githubClone(
			unrestrictedConfig,
			{ repo: 'owner/repo' },
			toolContext(worktree),
			{ gitBin: fakeGit },
		)
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error('Expected fake Git failure')
		const basic = Buffer.from('x-access-token:secret-token', 'utf8').toString('base64')
		expect(result.error.message).not.toContain('secret-token')
		expect(result.error.message).not.toContain(basic)
		expect(result.error.message).not.toContain(`${tokenEnv}`)
		expect(await readdir(path.join(worktree, '.limitless', 'repos'))).toEqual([])
	})

	test('loads clone authentication from tokenFile when configured', async () => {
		const root = await testRoot()
		const worktree = await createWorktree(root)
		const tokenFile = path.join(root, 'github-token')
		const fakeGit = path.join(root, 'fake-git.mjs')
		await writeFile(tokenFile, 'file-token\n', { mode: 0o600 })
		await writeFile(
			fakeGit,
			`#!/usr/bin/env node\nprocess.stderr.write(JSON.stringify(process.env)); process.exit(2)\n`,
		)
		await chmod(fakeGit, 0o755)

		const result = await githubClone(
			{ ...unrestrictedConfig, tokenFile },
			{ repo: 'owner/repo' },
			toolContext(worktree),
			{ gitBin: fakeGit },
		)
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error('Expected fake Git failure')
		expect(result.error.message).toContain('[REDACTED]')
		expect(result.error.message).not.toContain('file-token')
	})
})

describe('GitHub submodules', () => {
	test('normalizes accepted GitHub URL forms and rejects other hosts', () => {
		expect(resolveGitHubSubmoduleUrl('../shared.git', 'owner/parent')).toBe(
			'https://github.com/owner/shared.git',
		)
		expect(resolveGitHubSubmoduleUrl('git@github.com:Owner/Repo.git', 'ignored/parent')).toBe(
			'https://github.com/owner/repo.git',
		)
		expect(resolveGitHubSubmoduleUrl('ssh://git@github.com/Owner/Repo.git', 'ignored/parent')).toBe(
			'https://github.com/owner/repo.git',
		)
		expect(() =>
			resolveGitHubSubmoduleUrl('https://gitlab.com/owner/repo.git', 'owner/parent'),
		).toThrow(/github\.com/u)
	})

	test('enforces the allowlist before recursively initializing transitive submodules', async () => {
		const root = await testRoot()
		const grandchild = await initializeRepository(root, 'deps/grandchild')
		await publishRepository(root, grandchild)
		const child = await initializeRepository(root, 'deps/child')
		await addSubmodule(child, grandchild, 'vendor/grandchild')
		await publishRepository(root, child)
		const parent = await initializeRepository(root, 'owner/parent')
		await addSubmodule(parent, child, 'deps/child')
		await publishRepository(root, parent)
		const worktree = await createWorktree(root)
		const options = cloneOptions([parent, child, grandchild])

		const denied = await githubClone(
			{ tokenEnv, allowedRepos: [parent.repo], allowUnrestrictedRepos: false },
			{ repo: parent.repo },
			toolContext(worktree),
			options,
		)
		expect(denied.ok).toBe(false)
		if (denied.ok) throw new Error('Expected submodule policy failure')
		expect(denied.error.code).toBe('REPOSITORY_NOT_ALLOWED')
		expect(denied.submodules?.complete).toBe(false)
		expect(await readdir(path.join(worktree, '.limitless', 'repos'))).toEqual([])

		const allowed = await githubClone(
			{
				tokenEnv,
				allowedRepos: [parent.repo, child.repo, grandchild.repo],
				allowUnrestrictedRepos: false,
			},
			{ repo: parent.repo },
			toolContext(worktree),
			options,
		)
		if (!allowed.ok) throw new Error(`${allowed.error.code}: ${allowed.error.message}`)
		expect(allowed.ok).toBe(true)
		expect(allowed.submodules.entries).toEqual([
			expect.objectContaining({ path: 'deps/child', repo: child.repo, depth: 1 }),
			expect.objectContaining({
				path: 'deps/child/vendor/grandchild',
				repo: grandchild.repo,
				depth: 2,
			}),
		])
		expect(allowed.lfsObjectsMaterialized).toBe(false)
	})
})
