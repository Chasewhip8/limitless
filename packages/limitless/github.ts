import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { Effect, Schema } from 'effect'
import { ToolInputError } from './lib/errors'
import {
	type GitHubCodeSearchInput,
	GitHubCodeSearchInput as GitHubCodeSearchInputSchema,
	type GitHubCodeSearchResult,
	type GitHubConfig,
	type GitHubFileReadInput,
	GitHubFileReadInput as GitHubFileReadInputSchema,
	type GitHubFileReadResult,
	GitHubOptionsBlock,
	type GitHubPluginConfig,
	type GitHubRepoTreeInput,
	GitHubRepoTreeInput as GitHubRepoTreeInputSchema,
	type GitHubRepoTreeResult,
	type RateLimitInfo,
} from './lib/github'
import { describeUnknown, objectProperty, optionalField } from './shared'

export {
	GitHubCodeSearchInputSchema as GitHubCodeSearchInput,
	type GitHubCodeSearchResult,
	type GitHubConfig,
	GitHubFileReadInputSchema as GitHubFileReadInput,
	type GitHubFileReadResult,
	GitHubOptionsBlock,
	type GitHubPluginConfig,
	GitHubRepoTreeInputSchema as GitHubRepoTreeInput,
	type GitHubRepoTreeResult,
	type RateLimitInfo,
}

const DEFAULT_TOKEN_ENV = 'GITHUB_TOKEN'
const DEFAULT_SEARCH_RESULTS = 10
const MAX_SEARCH_RESULTS = 20
const DEFAULT_FILE_BYTES = 200_000
const MAX_FILE_BYTES = 1_000_000
const DEFAULT_TREE_ENTRIES = 200
const MAX_TREE_ENTRIES = 1_000
const DEFAULT_FETCH_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 2_000_000

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined || !Number.isInteger(value) || value <= 0) return fallback
	return Math.min(value, maximum)
}

function trimmed(value: string | undefined): string | undefined {
	if (value === undefined) return undefined
	const result = value.trim()
	return result.length === 0 ? undefined : result
}

function withGaps<T extends Record<string, unknown>>(
	payload: T,
	gaps: ReadonlyArray<string>,
): T | (T & { readonly gaps: ReadonlyArray<string> }) {
	return gaps.length === 0 ? payload : { ...payload, gaps }
}

function disabledGitHubConfig(): GitHubPluginConfig {
	return {
		enabled: false,
		config: {
			tokenEnv: DEFAULT_TOKEN_ENV,
			allowedRepos: [],
			allowUnrestrictedRepos: false,
		},
	}
}

function warnInvalidConfig(error: unknown): void {
	console.warn(`[limitless] invalid github config: ${describeUnknown(error)}`)
}

export function normalizeGitHubPluginConfig(options: unknown): GitHubPluginConfig {
	const github = objectProperty(options, 'github')
	if (github === undefined) return disabledGitHubConfig()

	let decoded: typeof GitHubOptionsBlock.Type
	try {
		decoded = Schema.decodeUnknownSync(GitHubOptionsBlock)(github)
	} catch (error) {
		warnInvalidConfig(error)
		return disabledGitHubConfig()
	}

	const tokenEnv = trimmed(decoded.tokenEnv) ?? DEFAULT_TOKEN_ENV
	const tokenFile = trimmed(decoded.tokenFile)

	return {
		enabled: decoded.enable === true,
		config: {
			tokenEnv,
			...optionalField('tokenFile', tokenFile),
			allowedRepos: decoded.allowedRepos ?? [],
			allowUnrestrictedRepos: decoded.allowUnrestrictedRepos ?? false,
		},
	}
}

export function normalizeRepo(repo: string): string {
	const trimmedRepo = repo.trim()
	const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/u.exec(
		trimmedRepo,
	)
	if (match === null || match[1] === undefined || match[2] === undefined) {
		throw new Error(`Invalid GitHub repository name: ${repo}`)
	}
	return `${match[1].toLowerCase()}/${match[2].toLowerCase()}`
}

export function assertAllowedRepo(repo: string, allowedRepos: ReadonlyArray<string>): string {
	const normalized = normalizeRepo(repo)
	if (allowedRepos.length === 0) return normalized

	const allowed = new Set(allowedRepos.map(normalizeRepo))
	if (!allowed.has(normalized)) {
		throw new Error(`Repository ${normalized} is not in the configured GitHub allowlist.`)
	}
	return normalized
}

function repoAccessGap(config: GitHubConfig): string | undefined {
	return config.allowedRepos.length === 0 && !config.allowUnrestrictedRepos
		? 'GitHub allowedRepos must be non-empty unless allowUnrestrictedRepos is explicitly enabled.'
		: undefined
}

function assertConfiguredRepo(repo: string, config: GitHubConfig): string {
	const gap = repoAccessGap(config)
	if (gap !== undefined) throw new Error(gap)
	return assertAllowedRepo(repo, config.allowedRepos)
}

function parseHeaderNumber(headers: Headers, name: string): number | undefined {
	const value = headers.get(name)
	if (value === null) return undefined
	const parsed = Number.parseInt(value, 10)
	return Number.isFinite(parsed) ? parsed : undefined
}

export function parseRateLimitHeaders(headers: Headers): RateLimitInfo {
	return {
		...optionalField('limit', parseHeaderNumber(headers, 'x-ratelimit-limit')),
		...optionalField('remaining', parseHeaderNumber(headers, 'x-ratelimit-remaining')),
		...optionalField('reset', parseHeaderNumber(headers, 'x-ratelimit-reset')),
		...optionalField('retryAfter', parseHeaderNumber(headers, 'retry-after')),
	}
}

export async function githubFetch(path: string, init: RequestInit): Promise<Response> {
	const url = path.startsWith('https://') ? path : `https://api.github.com${path}`
	const controller = new AbortController()
	const timeout = setTimeout(() => {
		controller.abort(new Error(`GitHub request exceeded ${DEFAULT_FETCH_TIMEOUT_MS}ms.`))
	}, DEFAULT_FETCH_TIMEOUT_MS)

	try {
		return await fetch(url, { ...init, signal: init.signal ?? controller.signal })
	} finally {
		clearTimeout(timeout)
	}
}

function safePathSegments(value: string): ReadonlyArray<string> {
	const segments = value.split('/')
	if (
		segments.length === 0 ||
		segments.some(
			(segment) =>
				segment.length === 0 || segment === '.' || segment === '..' || segment.includes('\\'),
		)
	) {
		throw new Error(
			'GitHub file paths cannot contain empty, current-directory, or parent-directory segments.',
		)
	}
	return segments
}

function encodePathSegments(value: string): string {
	return safePathSegments(value).map(encodeURIComponent).join('/')
}

function repoApiPath(repo: string): string {
	const [owner, name] = repo.split('/')
	if (owner === undefined || name === undefined)
		throw new Error(`Invalid GitHub repository name: ${repo}`)
	return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

async function configuredToken(config: GitHubConfig): Promise<string | undefined> {
	if (config.tokenFile !== undefined) {
		try {
			return trimmed(await readFile(config.tokenFile, 'utf8'))
		} catch (error) {
			throw new Error(
				`Failed to read GitHub token file ${config.tokenFile}: ${describeUnknown(error)}`,
			)
		}
	}

	return trimmed(process.env[config.tokenEnv])
}

function authSource(config: GitHubConfig): string {
	return config.tokenFile === undefined ? config.tokenEnv : `token file ${config.tokenFile}`
}

async function requestHeaders(config: GitHubConfig, accept: string): Promise<Headers> {
	const headers = new Headers({
		accept,
		'user-agent': 'limitless-opencode',
		'x-github-api-version': '2022-11-28',
	})
	const token = await configuredToken(config)
	if (token !== undefined) {
		headers.set('authorization', `Bearer ${token}`)
	}
	return headers
}

async function githubGet(
	config: GitHubConfig,
	path: string,
	accept = 'application/vnd.github+json',
) {
	return githubFetch(path, {
		method: 'GET',
		headers: await requestHeaders(config, accept),
	})
}

async function responseText(response: Response): Promise<string> {
	const contentLength = parseHeaderNumber(response.headers, 'content-length')
	if (contentLength !== undefined && contentLength > MAX_RESPONSE_BYTES) {
		throw new Error(
			`GitHub response is ${contentLength} bytes, which exceeds ${MAX_RESPONSE_BYTES} bytes.`,
		)
	}

	const body = response.body
	if (body === null) {
		const text = await response.text()
		if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
			throw new Error(`GitHub response exceeds ${MAX_RESPONSE_BYTES} bytes.`)
		}
		return text
	}

	const reader = body.getReader()
	const chunks: Array<Buffer> = []
	let total = 0
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		if (value === undefined) continue
		total += value.byteLength
		if (total > MAX_RESPONSE_BYTES) {
			await reader.cancel()
			throw new Error(`GitHub response exceeds ${MAX_RESPONSE_BYTES} bytes.`)
		}
		chunks.push(Buffer.from(value))
	}
	return Buffer.concat(chunks).toString('utf8')
}

async function responseJson(response: Response): Promise<unknown> {
	const text = await responseText(response)
	if (text.length === 0) return undefined
	return JSON.parse(text)
}

async function responseMessage(response: Response): Promise<string | undefined> {
	try {
		const value = await responseJson(response)
		return stringValue(objectProperty(value, 'message'))
	} catch (error) {
		return describeUnknown(error)
	}
}

async function httpFailureGaps(response: Response, action: string): Promise<ReadonlyArray<string>> {
	const message = await responseMessage(response)
	const gaps = [`GitHub ${action} failed with HTTP ${response.status}.`]
	if (message !== undefined && message.length > 0) gaps.push(message)
	if (response.status === 401) gaps.push('GitHub authentication failed or the token is invalid.')
	if (response.status === 403)
		gaps.push('GitHub denied the request; check auth, repository access, or rate limits.')
	if (response.status === 429)
		gaps.push(
			'GitHub rate limited the request; retry after the reported reset or retry-after time.',
		)
	return gaps
}

function queryValue(value: string | undefined, qualifier: string): string | undefined {
	const item = safeQualifierValue(value, qualifier)
	return item === undefined ? undefined : `${qualifier}:${item}`
}

function safeQualifierValue(value: string | undefined, field: string): string | undefined {
	const item = trimmed(value)
	if (item === undefined) return undefined
	if (/[:\s"']/u.test(item) || hasScopeQualifier(item)) {
		throw new Error(
			`GitHub ${field} qualifier cannot contain whitespace, quotes, colons, or scope qualifiers.`,
		)
	}
	return item
}

function normalizeOwner(value: string | undefined): string | undefined {
	const owner = trimmed(value)
	if (owner === undefined) return undefined
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner)) {
		throw new Error(`Invalid GitHub owner name: ${owner}`)
	}
	return owner.toLowerCase()
}

function ownerRepoCandidates(
	input: GitHubCodeSearchInput,
	allowedRepos: ReadonlyArray<string>,
): ReadonlyArray<string> {
	if (input.repos !== undefined && input.repos.length > 0) return input.repos
	if (allowedRepos.length === 0) return []

	const owner = normalizeOwner(input.owner)
	if (owner === undefined) return allowedRepos
	return allowedRepos.filter((repo) => normalizeRepo(repo).startsWith(`${owner}/`))
}

function codeSearchQuery(input: GitHubCodeSearchInput, repo: string | undefined): string {
	const owner = repo === undefined ? normalizeOwner(input.owner) : undefined
	const terms = [
		trimmed(input.query),
		repo === undefined ? undefined : `repo:${repo}`,
		owner === undefined ? undefined : `user:${owner}`,
		queryValue(input.language, 'language'),
		queryValue(input.filename, 'filename'),
		queryValue(input.extension, 'extension'),
	]

	return terms.filter((term) => term !== undefined).join(' ')
}

function hasScopeQualifier(value: string | undefined): boolean {
	return /(?:^|\s)(?:repo|org|user):\S+/iu.test(value ?? '')
}

function hasAllowlistUnsafeSearchSyntax(value: string | undefined): boolean {
	const query = value ?? ''
	return (
		/(?:^|\s)-?[A-Za-z][A-Za-z-]*:\S+/u.test(query) ||
		/\b(?:OR|NOT)\b/iu.test(query) ||
		/[()]/u.test(query)
	)
}

function allowedSearchResults(
	results: ReadonlyArray<GitHubCodeSearchResult['results'][number]>,
	allowedRepos: ReadonlyArray<string>,
): {
	readonly results: ReadonlyArray<GitHubCodeSearchResult['results'][number]>
	readonly omitted: number
} {
	if (allowedRepos.length === 0) return { results, omitted: 0 }
	const allowed = new Set(allowedRepos.map(normalizeRepo))
	const filtered = results.filter((result) => allowed.has(normalizeRepo(result.repo)))
	return { results: filtered, omitted: results.length - filtered.length }
}

function textMatches(value: unknown): GitHubCodeSearchResult['results'][number]['textMatches'] {
	if (!Array.isArray(value)) return undefined
	const matches = value
		.map((item) => {
			const fragment = stringValue(objectProperty(item, 'fragment'))
			if (fragment === undefined) return undefined
			const rawMatches = objectProperty(item, 'matches')
			return {
				fragment,
				...(Array.isArray(rawMatches) ? { matches: rawMatches } : {}),
			}
		})
		.filter((item) => item !== undefined)
	return matches.length === 0 ? undefined : matches
}

function searchResultItem(value: unknown): GitHubCodeSearchResult['results'][number] | undefined {
	const repo = stringValue(objectProperty(objectProperty(value, 'repository'), 'full_name'))
	const path = stringValue(objectProperty(value, 'path'))
	if (repo === undefined || path === undefined) return undefined

	const sha = stringValue(objectProperty(value, 'sha'))
	const htmlUrl = stringValue(objectProperty(value, 'html_url'))
	const score = numberValue(objectProperty(value, 'score'))
	const matches = textMatches(objectProperty(value, 'text_matches'))
	return {
		repo: normalizeRepo(repo),
		path,
		...optionalField('sha', sha),
		...optionalField('htmlUrl', htmlUrl),
		...optionalField('score', score),
		...optionalField('textMatches', matches),
	}
}

async function githubCodeSearchRequest(
	config: GitHubConfig,
	input: GitHubCodeSearchInput,
): Promise<GitHubCodeSearchResult> {
	try {
		const gaps: Array<string> = []
		const accessGap = repoAccessGap(config)
		if (accessGap !== undefined) return { ok: false, results: [], gaps: [accessGap] }
		if ((await configuredToken(config)) === undefined) {
			return {
				ok: false,
				results: [],
				gaps: [`GitHub code search requires authentication via ${authSource(config)}.`],
			}
		}
		if (trimmed(input.query) === undefined && trimmed(input.filename) === undefined) {
			return { ok: false, results: [], gaps: ['GitHub code search requires a query or filename.'] }
		}
		if (config.allowedRepos.length > 0 && hasAllowlistUnsafeSearchSyntax(input.query)) {
			return {
				ok: false,
				results: [],
				gaps: [
					'Free-form query cannot include GitHub qualifiers, boolean operators, or grouping when allowedRepos is configured; use structured inputs instead.',
				],
			}
		}

		const limit = positiveInteger(input.maxResults, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS)
		const repos = ownerRepoCandidates(input, config.allowedRepos).map((repo) =>
			assertAllowedRepo(repo, config.allowedRepos),
		)
		if (input.repos === undefined && config.allowedRepos.length > 0 && repos.length === 0) {
			return {
				ok: false,
				results: [],
				gaps: ['No configured allowedRepos match the requested owner.'],
			}
		}
		if (repos.length === 0) {
			gaps.push(
				'Broad public code search depends on GitHub indexing and searches default branches only.',
			)
		}

		let rateLimit: RateLimitInfo | undefined
		const results: Array<GitHubCodeSearchResult['results'][number]> = []
		const seen = new Set<string>()
		const targetRepos: ReadonlyArray<string | undefined> = repos.length === 0 ? [undefined] : repos

		for (const repo of targetRepos) {
			const params = new URLSearchParams({
				q: codeSearchQuery(input, repo),
				per_page: String(limit),
			})
			const response = await githubGet(
				config,
				`/search/code?${params}`,
				'application/vnd.github.text-match+json',
			)
			rateLimit = parseRateLimitHeaders(response.headers)
			if (!response.ok) {
				return {
					ok: false,
					results: [],
					rateLimit,
					gaps: await httpFailureGaps(response, 'code search'),
				}
			}

			const body = await responseJson(response)
			const items = objectProperty(body, 'items')
			const rawResults = Array.isArray(items)
				? items.map(searchResultItem).filter((item) => item !== undefined)
				: []
			const allowed = allowedSearchResults(rawResults, config.allowedRepos)
			if (allowed.omitted > 0) {
				gaps.push('Omitted GitHub code search result(s) outside allowedRepos.')
			}
			for (const result of allowed.results) {
				const key = `${result.repo}\0${result.path}\0${result.sha ?? ''}`
				if (seen.has(key)) continue
				seen.add(key)
				results.push(result)
				if (results.length >= limit) break
			}
			if (results.length >= limit) break
		}

		if (results.length === 0) gaps.push('GitHub code search returned no results.')
		return withGaps(
			{ ok: results.length > 0, results, ...optionalField('rateLimit', rateLimit) },
			gaps,
		)
	} catch (error) {
		return { ok: false, results: [], gaps: [describeUnknown(error)] }
	}
}

function decodeBase64Content(value: string): string | undefined {
	const normalized = value.replace(/\s+/gu, '')
	if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4 === 1) return undefined
	const decoded = Buffer.from(normalized, 'base64')
	const encoded = decoded.toString('base64').replace(/=+$/u, '')
	if (encoded !== normalized.replace(/=+$/u, '')) return undefined
	return decoded.toString('utf8')
}

async function githubFileReadRequest(
	config: GitHubConfig,
	input: GitHubFileReadInput,
): Promise<GitHubFileReadResult> {
	let repo = input.repo
	try {
		repo = assertConfiguredRepo(input.repo, config)
		const gaps: Array<string> = []
		const targetPath = trimmed(input.path)
		if (targetPath === undefined) {
			return { ok: false, repo, path: input.path, gaps: ['GitHub file path is required.'] }
		}
		if (input.ref === undefined) {
			gaps.push('No ref supplied; GitHub will read from the repository default branch.')
		}

		const maxBytes = positiveInteger(input.maxBytes, DEFAULT_FILE_BYTES, MAX_FILE_BYTES)
		const params = input.ref === undefined ? '' : `?${new URLSearchParams({ ref: input.ref })}`
		const response = await githubGet(
			config,
			`/repos/${repoApiPath(repo)}/contents/${encodePathSegments(targetPath)}${params}`,
		)
		const rateLimit = parseRateLimitHeaders(response.headers)
		if (!response.ok) {
			const failureGaps = await httpFailureGaps(response, 'file read')
			return {
				ok: false,
				repo,
				path: targetPath,
				...optionalField('ref', input.ref),
				rateLimit,
				gaps: [...gaps, ...failureGaps],
			}
		}

		const body = await responseJson(response)
		if (Array.isArray(body)) {
			gaps.push('GitHub contents response is a directory; request a specific file path.')
			return withGaps({ ok: false, repo, path: targetPath, rateLimit }, gaps)
		}

		const size = numberValue(objectProperty(body, 'size'))
		const sha = stringValue(objectProperty(body, 'sha'))
		const encoding = stringValue(objectProperty(body, 'encoding'))
		const htmlUrl = stringValue(objectProperty(body, 'html_url'))
		if (size !== undefined && size > maxBytes) {
			gaps.push(`GitHub file is ${size} bytes, which exceeds maxBytes ${maxBytes}.`)
			return withGaps(
				{
					ok: false,
					repo,
					path: targetPath,
					...optionalField('ref', input.ref),
					...optionalField('sha', sha),
					...optionalField('encoding', encoding),
					...optionalField('htmlUrl', htmlUrl),
					...optionalField('size', size),
					rateLimit,
				},
				gaps,
			)
		}

		const rawContent = stringValue(objectProperty(body, 'content'))
		const content =
			encoding === 'base64' && rawContent !== undefined
				? decodeBase64Content(rawContent)
				: undefined
		if (content === undefined) gaps.push('GitHub file content was absent or not valid base64 text.')

		return withGaps(
			{
				ok: content !== undefined,
				repo,
				path: targetPath,
				...optionalField('ref', input.ref),
				...optionalField('sha', sha),
				...optionalField('content', content),
				...optionalField('encoding', encoding),
				...optionalField('htmlUrl', htmlUrl),
				...optionalField('size', size),
				rateLimit,
			},
			gaps,
		)
	} catch (error) {
		return { ok: false, repo, path: input.path, gaps: [describeUnknown(error)] }
	}
}

function normalizeTreeType(
	value: unknown,
	mode: unknown,
): 'file' | 'dir' | 'symlink' | 'submodule' | 'unknown' {
	if (mode === '160000' || value === 'commit') return 'submodule'
	if (mode === '120000') return 'symlink'
	if (value === 'blob') return 'file'
	if (value === 'tree') return 'dir'
	if (value === 'symlink' || value === 'submodule') return value
	return 'unknown'
}

function treeEntry(value: unknown): GitHubRepoTreeResult['entries'][number] | undefined {
	const path = stringValue(objectProperty(value, 'path'))
	if (path === undefined) return undefined
	const sha = stringValue(objectProperty(value, 'sha'))
	const size = numberValue(objectProperty(value, 'size'))
	const mode = objectProperty(value, 'mode')
	return {
		path,
		type: normalizeTreeType(objectProperty(value, 'type'), mode),
		...optionalField('sha', sha),
		...optionalField('size', size),
	}
}

function normalizePathPrefix(value: string | undefined): string | undefined {
	const prefix = trimmed(value)?.replace(/^\/+|\/+$/gu, '')
	return prefix === '' ? undefined : prefix
}

async function githubRepoTreeRequest(
	config: GitHubConfig,
	input: GitHubRepoTreeInput,
): Promise<GitHubRepoTreeResult> {
	let repo = input.repo
	try {
		repo = assertConfiguredRepo(input.repo, config)
		const gaps: Array<string> = []
		if (input.ref === undefined) {
			gaps.push('No ref supplied; GitHub will inspect the repository default branch.')
		}
		const recursive = input.recursive === true
		if (!recursive) {
			gaps.push(
				'Repo tree inspection is non-recursive by default; set recursive true for nested entries.',
			)
		}
		const ref = input.ref ?? 'HEAD'
		const params = recursive ? '?recursive=1' : ''
		const response = await githubGet(
			config,
			`/repos/${repoApiPath(repo)}/git/trees/${encodeURIComponent(ref)}${params}`,
		)
		const rateLimit = parseRateLimitHeaders(response.headers)
		if (!response.ok) {
			const failureGaps = await httpFailureGaps(response, 'repo tree')
			return {
				ok: false,
				repo,
				...optionalField('ref', input.ref),
				entries: [],
				rateLimit,
				gaps: [...gaps, ...failureGaps],
			}
		}

		const body = await responseJson(response)
		const prefix = normalizePathPrefix(input.pathPrefix)
		const rawTree = objectProperty(body, 'tree')
		const allEntries = Array.isArray(rawTree)
			? rawTree
					.map(treeEntry)
					.filter((item) => item !== undefined)
					.filter(
						(item) =>
							prefix === undefined || item.path === prefix || item.path.startsWith(`${prefix}/`),
					)
			: []
		const limit = positiveInteger(input.maxEntries, DEFAULT_TREE_ENTRIES, MAX_TREE_ENTRIES)
		const entries = allEntries.slice(0, limit)
		const truncated = objectProperty(body, 'truncated') === true || allEntries.length > limit
		if (entries.length === 0) gaps.push('GitHub repo tree returned no matching entries.')
		if (objectProperty(body, 'truncated') === true) {
			gaps.push('GitHub truncated the recursive tree response; inspect narrower subtrees.')
		}

		return withGaps(
			{
				ok: entries.length > 0,
				repo,
				...optionalField('ref', input.ref),
				...optionalField('recursive', recursive ? true : undefined),
				entries,
				...optionalField('truncated', truncated ? true : undefined),
				rateLimit,
			},
			gaps,
		)
	} catch (error) {
		return { ok: false, repo, entries: [], gaps: [describeUnknown(error)] }
	}
}

export const githubCodeSearch = Effect.fn(function* githubCodeSearch(
	config: GitHubConfig,
	input: GitHubCodeSearchInput,
) {
	return yield* Effect.tryPromise({
		try: () => githubCodeSearchRequest(config, input),
		catch: (error) =>
			new ToolInputError({
				tool: 'github_code_search',
				message: describeUnknown(error),
			}),
	})
})

export const githubFileRead = Effect.fn(function* githubFileRead(
	config: GitHubConfig,
	input: GitHubFileReadInput,
) {
	return yield* Effect.tryPromise({
		try: () => githubFileReadRequest(config, input),
		catch: (error) =>
			new ToolInputError({
				tool: 'github_file_read',
				message: describeUnknown(error),
			}),
	})
})

export const githubRepoTree = Effect.fn(function* githubRepoTree(
	config: GitHubConfig,
	input: GitHubRepoTreeInput,
) {
	return yield* Effect.tryPromise({
		try: () => githubRepoTreeRequest(config, input),
		catch: (error) =>
			new ToolInputError({
				tool: 'github_repo_tree',
				message: describeUnknown(error),
			}),
	})
})
