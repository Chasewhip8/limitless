import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
	assertAllowedRepo,
	githubCodeSearch as githubCodeSearchEffect,
	githubFileRead as githubFileReadEffect,
	githubRepoTree as githubRepoTreeEffect,
	normalizeGitHubPluginConfig,
	normalizeRepo,
	parseRateLimitHeaders,
} from '../github'

const tokenEnv = 'LIMITLESS_TEST_GITHUB_TOKEN'
const config = { tokenEnv, allowedRepos: [], allowUnrestrictedRepos: true }
const tempDirs: Array<string> = []

function githubCodeSearch(...args: Parameters<typeof githubCodeSearchEffect>) {
	return Effect.runPromise(githubCodeSearchEffect(...args))
}

function githubFileRead(...args: Parameters<typeof githubFileReadEffect>) {
	return Effect.runPromise(githubFileReadEffect(...args))
}

function githubRepoTree(...args: Parameters<typeof githubRepoTreeEffect>) {
	return Effect.runPromise(githubRepoTreeEffect(...args))
}

async function tokenFile(content: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'limitless-github-'))
	tempDirs.push(dir)
	const path = join(dir, 'token')
	await writeFile(path, content, { mode: 0o600 })
	return path
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		...init,
		headers: {
			'content-type': 'application/json',
			...(init.headers instanceof Headers
				? Object.fromEntries(init.headers.entries())
				: init.headers),
		},
	})
}

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async () => response)
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

function fetchCall(fetchMock: ReturnType<typeof vi.fn>, index = 0): [string, RequestInit] {
	const call = fetchMock.mock.calls[index]
	if (call === undefined) throw new Error('Expected fetch to be called.')
	const url = call[0]
	const init = call[1]
	if (typeof url !== 'string' || init === undefined) throw new Error('Unexpected fetch call shape.')
	return [url, init]
}

function fetchHeaders(fetchMock: ReturnType<typeof vi.fn>): Headers {
	const [, init] = fetchCall(fetchMock, fetchMock.mock.calls.length - 1)
	if (!(init.headers instanceof Headers)) throw new Error('Expected Headers instance.')
	return init.headers
}

function fetchUrl(fetchMock: ReturnType<typeof vi.fn>): URL {
	const [url] = fetchCall(fetchMock)
	return new URL(url)
}

afterEach(async () => {
	delete process.env[tokenEnv]
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
	vi.unstubAllGlobals()
})

describe('GitHub helpers', () => {
	test('Authorization header is included only when token exists', async () => {
		const fetchMock = mockFetch(
			jsonResponse({
				path: 'src/a.ts',
				sha: 'abc',
				encoding: 'base64',
				content: Buffer.from('hello').toString('base64'),
				size: 5,
			}),
		)

		await githubFileRead(config, { repo: 'owner/repo', path: 'src/a.ts' })
		expect(fetchHeaders(fetchMock).get('authorization')).toBeNull()

		process.env[tokenEnv] = 'secret-token'
		await githubFileRead(config, { repo: 'owner/repo', path: 'src/a.ts' })
		expect(fetchHeaders(fetchMock).get('authorization')).toBe('Bearer secret-token')
	})

	test('Authorization header can be sourced from a token file', async () => {
		const fetchMock = mockFetch(
			jsonResponse({
				path: 'src/a.ts',
				sha: 'abc',
				encoding: 'base64',
				content: Buffer.from('hello').toString('base64'),
				size: 5,
			}),
		)

		await githubFileRead(
			{ ...config, tokenFile: await tokenFile('file-token\n') },
			{ repo: 'owner/repo', path: 'src/a.ts' },
		)

		expect(fetchHeaders(fetchMock).get('authorization')).toBe('Bearer file-token')
	})

	test('plugin config accepts an optional token file', () => {
		expect(
			normalizeGitHubPluginConfig({
				github: {
					enable: true,
					tokenEnv: 'CUSTOM_TOKEN',
					tokenFile: ' /run/agenix/github-token ',
					allowUnrestrictedRepos: true,
				},
			}),
		).toEqual({
			enabled: true,
			config: {
				tokenEnv: 'CUSTOM_TOKEN',
				tokenFile: '/run/agenix/github-token',
				allowedRepos: [],
				allowUnrestrictedRepos: true,
			},
		})
	})

	test('plugin config is disabled without warnings when absent', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		expect(normalizeGitHubPluginConfig(undefined)).toEqual({
			enabled: false,
			config: {
				tokenEnv: 'GITHUB_TOKEN',
				allowedRepos: [],
				allowUnrestrictedRepos: false,
			},
		})
		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})

	test('plugin config disables and warns once for malformed blocks', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		expect(
			normalizeGitHubPluginConfig({
				github: {
					enable: true,
					allowedRepos: ['owner/repo', 42],
				},
			}),
		).toEqual({
			enabled: false,
			config: {
				tokenEnv: 'GITHUB_TOKEN',
				allowedRepos: [],
				allowUnrestrictedRepos: false,
			},
		})
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0]?.[0]).toContain('[limitless] invalid github config:')
		warn.mockRestore()
	})

	test('invalid repo names are rejected', () => {
		expect(() => normalizeRepo('not-a-repo')).toThrow(/Invalid GitHub repository name/u)
		expect(() => normalizeRepo('../owner/repo')).toThrow(/Invalid GitHub repository name/u)
	})

	test('allowedRepos is enforced', () => {
		expect(assertAllowedRepo('Owner/Repo', ['owner/repo'])).toBe('owner/repo')
		expect(() => assertAllowedRepo('other/repo', ['owner/repo'])).toThrow(/allowlist/u)
	})

	test('GitHub tools require an allowlist unless unrestricted repos are explicit', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)

		const result = await githubFileRead(
			{ tokenEnv, allowedRepos: [], allowUnrestrictedRepos: false },
			{ repo: 'owner/repo', path: 'src/a.ts' },
		)

		expect(result.ok).toBe(false)
		expect(result.gaps?.join('\n')).toContain('allowUnrestrictedRepos')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('rate-limit headers are parsed', () => {
		const headers = new Headers({
			'x-ratelimit-limit': '60',
			'x-ratelimit-remaining': '0',
			'x-ratelimit-reset': '1710000000',
			'retry-after': '30',
		})

		expect(parseRateLimitHeaders(headers)).toEqual({
			limit: 60,
			remaining: 0,
			reset: 1710000000,
			retryAfter: 30,
		})
	})
})

describe('GitHub code search', () => {
	beforeEach(() => {
		process.env[tokenEnv] = 'secret-token'
	})

	test('code search requires authentication', async () => {
		delete process.env[tokenEnv]
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)

		const result = await githubCodeSearch(config, { query: 'createLimitless' })

		expect(result.ok).toBe(false)
		expect(result.gaps?.join('\n')).toContain('requires authentication')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('code search accepts authentication from a token file', async () => {
		delete process.env[tokenEnv]
		const fetchMock = mockFetch(jsonResponse({ items: [] }))

		await githubCodeSearch(
			{ ...config, tokenFile: await tokenFile('file-token') },
			{ query: 'createLimitless' },
		)

		expect(fetchHeaders(fetchMock).get('authorization')).toBe('Bearer file-token')
	})

	test('403/429 return structured gaps', async () => {
		for (const status of [403, 429]) {
			mockFetch(
				jsonResponse(
					{ message: 'limited' },
					{ status, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '10' } },
				),
			)

			const result = await githubCodeSearch(config, { query: 'createLimitless' })

			expect(result.ok).toBe(false)
			expect(result.rateLimit?.remaining).toBe(0)
			expect(result.rateLimit?.retryAfter).toBe(10)
			expect(result.gaps?.join('\n')).toContain(`HTTP ${status}`)
		}
	})

	test('maxResults is capped', async () => {
		const items = Array.from({ length: 30 }, (_, index) => ({
			path: `src/${index}.ts`,
			repository: { full_name: 'Owner/Repo' },
		}))
		const fetchMock = mockFetch(jsonResponse({ items }))

		const result = await githubCodeSearch(config, { query: 'needle', maxResults: 100 })

		expect(fetchUrl(fetchMock).searchParams.get('per_page')).toBe('20')
		expect(result.results).toHaveLength(20)
	})

	test('code search query includes repo qualifiers', async () => {
		const fetchMock = mockFetch(jsonResponse({ items: [] }))

		await githubCodeSearch(config, { query: 'needle', repos: ['Owner/Repo'] })

		expect(fetchUrl(fetchMock).searchParams.get('q')).toContain('repo:owner/repo')
	})

	test('code search rejects scope qualifiers when allowedRepos is configured', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)

		const result = await githubCodeSearch(
			{ tokenEnv, allowedRepos: ['owner/repo'], allowUnrestrictedRepos: false },
			{ query: 'repo:other/repo needle' },
		)

		expect(result.ok).toBe(false)
		expect(result.gaps?.join('\n')).toContain('allowedRepos')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('code search rejects qualifier injection outside the free-form query', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)

		const result = await githubCodeSearch(
			{ tokenEnv, allowedRepos: ['owner/repo'], allowUnrestrictedRepos: false },
			{ query: 'needle', filename: 'repo:other/repo' },
		)

		expect(result.ok).toBe(false)
		expect(result.gaps?.join('\n')).toContain('qualifier')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('code search rejects boolean and grouped free-form syntax with allowedRepos', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)

		for (const query of ['needle OR secret', 'needle NOT secret', '(needle secret)']) {
			const result = await githubCodeSearch(
				{ tokenEnv, allowedRepos: ['owner/repo'], allowUnrestrictedRepos: false },
				{ query },
			)

			expect(result.ok, query).toBe(false)
			expect(result.gaps?.join('\n'), query).toContain('allowedRepos')
		}
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('code search queries multiple repos separately', async () => {
		const fetchMock = vi.fn(async (url: string) => {
			const query = new URL(url).searchParams.get('q') ?? ''
			return jsonResponse({
				items: [
					{
						path: query.includes('repo:owner/other') ? 'src/b.ts' : 'src/a.ts',
						repository: {
							full_name: query.includes('repo:owner/other') ? 'owner/other' : 'owner/repo',
						},
					},
				],
			})
		})
		vi.stubGlobal('fetch', fetchMock)

		const result = await githubCodeSearch(
			{ tokenEnv, allowedRepos: ['owner/repo', 'owner/other'], allowUnrestrictedRepos: false },
			{ query: 'needle' },
		)

		expect(result.results.map((item) => item.repo)).toEqual(['owner/repo', 'owner/other'])
		expect(fetchMock).toHaveBeenCalledTimes(2)
		for (const [url] of fetchMock.mock.calls) {
			const query = new URL(url).searchParams.get('q') ?? ''
			expect(query.match(/repo:/gu)).toHaveLength(1)
		}
	})

	test('code search omits returned repos outside allowedRepos', async () => {
		mockFetch(
			jsonResponse({
				items: [
					{ path: 'src/a.ts', repository: { full_name: 'owner/repo' } },
					{ path: 'src/b.ts', repository: { full_name: 'other/repo' } },
				],
			}),
		)

		const result = await githubCodeSearch(
			{ tokenEnv, allowedRepos: ['owner/repo'], allowUnrestrictedRepos: false },
			{ query: 'needle' },
		)

		expect(result.results).toEqual([{ repo: 'owner/repo', path: 'src/a.ts' }])
		expect(result.gaps?.join('\n')).toContain('outside allowedRepos')
	})

	test('empty results return explicit gaps', async () => {
		mockFetch(jsonResponse({ items: [] }))

		const result = await githubCodeSearch(config, { query: 'needle', repos: ['owner/repo'] })

		expect(result.ok).toBe(false)
		expect(result.gaps?.join('\n')).toContain('no results')
	})
})

describe('GitHub file read', () => {
	test('file read rejects content over maxBytes', async () => {
		mockFetch(
			jsonResponse({
				path: 'src/a.ts',
				sha: 'abc',
				encoding: 'base64',
				content: Buffer.from('hello').toString('base64'),
				size: 100,
			}),
		)

		const result = await githubFileRead(config, {
			repo: 'owner/repo',
			path: 'src/a.ts',
			maxBytes: 10,
		})

		expect(result.ok).toBe(false)
		expect(result.content).toBeUndefined()
		expect(result.gaps?.join('\n')).toContain('exceeds maxBytes')
	})

	test('base64 content decodes safely', async () => {
		mockFetch(
			jsonResponse({
				path: 'src/a.ts',
				sha: 'abc',
				encoding: 'base64',
				content: Buffer.from('hello').toString('base64'),
				size: 5,
			}),
		)

		const result = await githubFileRead(config, { repo: 'owner/repo', path: 'src/a.ts' })

		expect(result.ok).toBe(true)
		expect(result.content).toBe('hello')
		expect(result.gaps?.join('\n')).toContain('default branch')
	})

	test('file read rejects traversal paths before fetching', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)

		const result = await githubFileRead(
			{ tokenEnv, allowedRepos: ['owner/repo'], allowUnrestrictedRepos: false },
			{ repo: 'owner/repo', path: '../../../other/repo/contents/secret.ts' },
		)

		expect(result.ok).toBe(false)
		expect(result.gaps?.join('\n')).toContain('parent-directory')
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe('GitHub repo tree', () => {
	test('repo tree respects maxEntries and truncated', async () => {
		mockFetch(
			jsonResponse({
				truncated: false,
				tree: [
					{ path: 'src', type: 'tree', sha: 'dir' },
					{ path: 'src/a.ts', type: 'blob', sha: 'a', size: 1 },
					{ path: 'src/b.ts', type: 'blob', sha: 'b', size: 1 },
				],
			}),
		)

		const result = await githubRepoTree(config, {
			repo: 'owner/repo',
			pathPrefix: 'src',
			maxEntries: 2,
		})

		expect(result.ok).toBe(true)
		expect(result.entries).toHaveLength(2)
		expect(result.truncated).toBe(true)
		expect(result.entries[0]?.type).toBe('dir')
	})

	test('repo tree is non-recursive by default and recursive on request', async () => {
		const fetchMock = mockFetch(jsonResponse({ tree: [] }))

		await githubRepoTree(config, { repo: 'owner/repo' })
		expect(fetchUrl(fetchMock).searchParams.get('recursive')).toBeNull()

		const recursiveFetchMock = mockFetch(jsonResponse({ tree: [] }))
		await githubRepoTree(config, { repo: 'owner/repo', recursive: true })
		expect(fetchUrl(recursiveFetchMock).searchParams.get('recursive')).toBe('1')
	})

	test('repo tree maps symlink and submodule modes', async () => {
		mockFetch(
			jsonResponse({
				tree: [
					{ path: 'vendor/lib', type: 'commit', mode: '160000', sha: 'submodule' },
					{ path: 'docs/latest', type: 'blob', mode: '120000', sha: 'symlink' },
				],
			}),
		)

		const result = await githubRepoTree(config, { repo: 'owner/repo', recursive: true })

		expect(result.entries.map((entry) => entry.type)).toEqual(['submodule', 'symlink'])
	})
})
