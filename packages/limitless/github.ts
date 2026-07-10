import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { ToolContext } from '@opencode-ai/plugin'
import { Effect, Schema } from 'effect'
import { ToolInputError } from './lib/errors'
import {
	type GitHubCloneInput,
	GitHubCloneInput as GitHubCloneInputSchema,
	type GitHubCloneResult,
	type GitHubConfig,
	GitHubOptionsBlock,
	type GitHubPluginConfig,
	type GitHubSubmodule,
} from './lib/github'
import {
	type CommandResult,
	describeUnknown,
	managedReposRoot,
	objectProperty,
	optionalField,
	pathIsInside,
	runCommand,
} from './shared'

export {
	GitHubCloneInputSchema as GitHubCloneInput,
	type GitHubCloneResult,
	type GitHubConfig,
	GitHubOptionsBlock,
	type GitHubPluginConfig,
	type GitHubSubmodule,
}

export const GIT_BIN = '@GIT_BIN@'

const DEFAULT_TOKEN_ENV = 'GITHUB_TOKEN'
const DEFAULT_GIT_TIMEOUT_MS = 120_000
const MAX_SUBMODULE_DEPTH = 32
const targetQueues = new Map<string, Promise<unknown>>()

type GitConfigEntry = { readonly key: string; readonly value: string }

export type GitHubCloneOptions = {
	readonly gitBin?: string
	readonly timeoutMs?: number
	readonly gitConfig?: ReadonlyArray<GitConfigEntry>
}

class CloneFailure extends Error {
	readonly code: string
	readonly submodules?: {
		readonly complete: false
		readonly entries: ReadonlyArray<GitHubSubmodule>
		readonly gaps: ReadonlyArray<string>
	}

	constructor(
		code: string,
		message: string,
		submodules?: {
			readonly complete: false
			readonly entries: ReadonlyArray<GitHubSubmodule>
			readonly gaps: ReadonlyArray<string>
		},
	) {
		super(message)
		this.name = 'CloneFailure'
		this.code = code
		if (submodules !== undefined) this.submodules = submodules
	}
}

type GitRuntime = {
	readonly gitBin: string
	readonly timeoutMs: number
	readonly signal: AbortSignal
	readonly env: Readonly<Record<string, string | undefined>>
	readonly secrets: ReadonlyArray<string>
}

function trimmed(value: string | undefined): string | undefined {
	if (value === undefined) return undefined
	const result = value.trim()
	return result.length === 0 ? undefined : result
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

	try {
		const decoded = Schema.decodeUnknownSync(GitHubOptionsBlock)(github)
		const allowedRepos = (decoded.allowedRepos ?? []).map(normalizeRepo)
		return {
			enabled: decoded.enable === true,
			config: {
				tokenEnv: trimmed(decoded.tokenEnv) ?? DEFAULT_TOKEN_ENV,
				...optionalField('tokenFile', trimmed(decoded.tokenFile)),
				allowedRepos: [...new Set(allowedRepos)],
				allowUnrestrictedRepos: decoded.allowUnrestrictedRepos ?? false,
			},
		}
	} catch (error) {
		warnInvalidConfig(error)
		return disabledGitHubConfig()
	}
}

export function normalizeRepo(repo: string): string {
	const value = repo.trim()
	const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/u.exec(value)
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

function assertConfiguredRepo(repo: string, config: GitHubConfig): string {
	if (config.allowedRepos.length === 0 && !config.allowUnrestrictedRepos) {
		throw new CloneFailure(
			'REPOSITORY_NOT_ALLOWED',
			'GitHub allowedRepos must be non-empty unless allowUnrestrictedRepos is explicitly enabled.',
		)
	}
	try {
		return assertAllowedRepo(repo, config.allowedRepos)
	} catch (error) {
		throw new CloneFailure('REPOSITORY_NOT_ALLOWED', describeUnknown(error))
	}
}

function cleanRemoteUrl(repo: string): string {
	return `https://github.com/${repo}.git`
}

function validateRef(ref: string | undefined): string | undefined {
	const value = trimmed(ref)
	if (value === undefined) {
		if (ref === undefined) return undefined
		throw new CloneFailure('INVALID_REF', 'GitHub ref cannot be empty.')
	}
	if (
		value.length > 256 ||
		!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) ||
		value.includes('..') ||
		value.includes('//') ||
		value.includes('@{') ||
		value.endsWith('/') ||
		value.endsWith('.') ||
		value.endsWith('.lock')
	) {
		throw new CloneFailure('INVALID_REF', `Invalid Git ref: ${value}`)
	}
	return value
}

function readableRef(ref: string): string {
	const readable = ref
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-+|-+$/gu, '')
		.slice(0, 40)
	return readable.length === 0 ? 'ref' : readable
}

export function cloneDirectoryName(repo: string, ref?: string): string {
	const normalized = normalizeRepo(repo)
	const base = `github-${normalized.replace('/', '-')}`
	if (ref === undefined) return base
	const validRef = validateRef(ref)
	if (validRef === undefined) throw new CloneFailure('INVALID_REF', 'GitHub ref cannot be empty.')
	const hash = createHash('sha256').update(validRef).digest('hex').slice(0, 12)
	return `${base}-${readableRef(validRef)}-${hash}`
}

async function configuredToken(config: GitHubConfig): Promise<string | undefined> {
	if (config.tokenFile !== undefined) {
		try {
			return trimmed(await readFile(config.tokenFile, 'utf8'))
		} catch (error) {
			throw new CloneFailure(
				'TOKEN_READ_FAILED',
				`Failed to read GitHub token file ${config.tokenFile}: ${describeUnknown(error)}`,
			)
		}
	}
	return trimmed(process.env[config.tokenEnv])
}

function sanitize(value: string, secrets: ReadonlyArray<string>): string {
	let result = value
	for (const secret of secrets) {
		if (secret.length > 0) result = result.replaceAll(secret, '[REDACTED]')
	}
	return result.replace(/https:\/\/[^\s/@]+@github\.com/giu, 'https://[REDACTED]@github.com')
}

function gitEnvironment(
	token: string | undefined,
	extraConfig: ReadonlyArray<GitConfigEntry>,
): {
	readonly env: Readonly<Record<string, string | undefined>>
	readonly secrets: ReadonlyArray<string>
} {
	if (token !== undefined && /[\r\n]/u.test(token)) {
		throw new CloneFailure('INVALID_TOKEN', 'GitHub token cannot contain line breaks.')
	}

	const authorization =
		token === undefined
			? undefined
			: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`
	const config: Array<GitConfigEntry> = [
		{ key: 'core.hooksPath', value: '/dev/null' },
		{ key: 'credential.interactive', value: 'false' },
		{ key: 'protocol.allow', value: 'never' },
		{ key: 'protocol.https.allow', value: 'always' },
		{ key: 'protocol.file.allow', value: 'never' },
		...(authorization === undefined
			? []
			: [{ key: 'http.https://github.com/.extraHeader', value: authorization }]),
		...extraConfig,
	]
	const env: Record<string, string> = {
		GCM_INTERACTIVE: 'Never',
		GIT_ASKPASS: '/bin/false',
		GIT_CONFIG_COUNT: String(config.length),
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_LFS_SKIP_SMUDGE: '1',
		GIT_TERMINAL_PROMPT: '0',
	}
	for (const [index, entry] of config.entries()) {
		env[`GIT_CONFIG_KEY_${index}`] = entry.key
		env[`GIT_CONFIG_VALUE_${index}`] = entry.value
	}
	return {
		env,
		secrets: [token, authorization].filter((value): value is string => value !== undefined),
	}
}

async function makeRuntime(
	config: GitHubConfig,
	context: ToolContext,
	options: GitHubCloneOptions,
): Promise<GitRuntime> {
	const auth = gitEnvironment(await configuredToken(config), options.gitConfig ?? [])
	return {
		gitBin: options.gitBin ?? GIT_BIN,
		timeoutMs: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
		signal: context.abort,
		env: { ...auth.env, [config.tokenEnv]: undefined },
		secrets: auth.secrets,
	}
}

async function runGit(
	runtime: GitRuntime,
	args: ReadonlyArray<string>,
	cwd: string,
): Promise<CommandResult> {
	const result = await Effect.runPromise(
		runCommand(runtime.gitBin, args, {
			cwd,
			timeout: runtime.timeoutMs,
			env: runtime.env,
			signal: runtime.signal,
		}),
	)
	return {
		...result,
		stdout: sanitize(result.stdout, runtime.secrets),
		stderr: sanitize(result.stderr, runtime.secrets),
	}
}

async function git(
	runtime: GitRuntime,
	cwd: string,
	action: string,
	args: ReadonlyArray<string>,
): Promise<string> {
	const result = await runGit(runtime, args, cwd)
	if (!result.ok) {
		if (runtime.signal.aborted) throw new CloneFailure('ABORTED', `Git ${action} was aborted.`)
		const detail = trimmed(result.stderr) ?? trimmed(result.stdout) ?? 'Git exited without output.'
		throw new CloneFailure('GIT_COMMAND_FAILED', `Git ${action} failed: ${detail}`)
	}
	return result.stdout.trim()
}

async function pathState(filePath: string): Promise<'missing' | 'directory' | 'symlink' | 'other'> {
	try {
		const stat = await lstat(filePath)
		if (stat.isSymbolicLink()) return 'symlink'
		if (stat.isDirectory()) return 'directory'
		return 'other'
	} catch (error) {
		if (objectProperty(error, 'code') === 'ENOENT') return 'missing'
		throw error
	}
}

async function ensureManagedRoot(worktree: string): Promise<string> {
	const root = managedReposRoot(worktree)
	const limitless = path.dirname(root)
	for (const directory of [limitless, root]) {
		const state = await pathState(directory)
		if (state === 'symlink') {
			throw new CloneFailure('UNSAFE_STORAGE_PATH', `${directory} cannot be a symbolic link.`)
		}
		if (state === 'other') {
			throw new CloneFailure('UNSAFE_STORAGE_PATH', `${directory} must be a directory.`)
		}
		if (state === 'missing') {
			try {
				await mkdir(directory)
			} catch (error) {
				if (objectProperty(error, 'code') !== 'EEXIST') throw error
			}
			if ((await pathState(directory)) !== 'directory') {
				throw new CloneFailure('UNSAFE_STORAGE_PATH', `${directory} must be a directory.`)
			}
		}
	}
	const [realWorktree, realRoot] = await Promise.all([realpath(worktree), realpath(root)])
	if (!pathIsInside(realWorktree, realRoot)) {
		throw new CloneFailure(
			'UNSAFE_STORAGE_PATH',
			'Managed repository storage escapes the worktree.',
		)
	}
	return root
}

async function validateCheckout(
	runtime: GitRuntime,
	target: string,
	expectedUrl: string,
): Promise<void> {
	if ((await pathState(target)) !== 'directory') {
		throw new CloneFailure('CHECKOUT_IDENTITY_MISMATCH', 'Managed checkout is not a directory.')
	}
	const top = await git(runtime, target, 'checkout identity inspection', [
		'rev-parse',
		'--show-toplevel',
	])
	const [realTarget, realTop] = await Promise.all([realpath(target), realpath(top)])
	if (realTarget !== realTop) {
		throw new CloneFailure(
			'CHECKOUT_IDENTITY_MISMATCH',
			'Managed checkout does not identify itself as the expected repository root.',
		)
	}
	const origins = (
		await git(runtime, target, 'origin inspection', [
			'config',
			'--local',
			'--get-all',
			'remote.origin.url',
		])
	)
		.split(/\r?\n/gu)
		.filter((line) => line.length > 0)
	if (origins.length !== 1 || origins[0] !== expectedUrl) {
		throw new CloneFailure(
			'CHECKOUT_IDENTITY_MISMATCH',
			'Managed checkout origin does not match the requested GitHub repository.',
		)
	}
}

async function assertClean(runtime: GitRuntime, target: string): Promise<void> {
	const status = await git(runtime, target, 'working tree status inspection', [
		'status',
		'--porcelain=v1',
		'--untracked-files=all',
		'--ignore-submodules=none',
	])
	if (status.length > 0) {
		throw new CloneFailure(
			'DIRTY_CHECKOUT',
			'Managed checkout has tracked, untracked, or submodule changes; refusing to update it.',
		)
	}
}

function parseDefaultHead(output: string): string {
	for (const line of output.split(/\r?\n/gu)) {
		const symbolic = /^ref:\s+(refs\/heads\/[^\s]+)\s+HEAD$/u.exec(line)
		if (symbolic?.[1] !== undefined) return symbolic[1]
	}
	for (const line of output.split(/\r?\n/gu)) {
		const direct = /^([0-9a-fA-F]{40,64})\s+HEAD$/u.exec(line)
		if (direct?.[1] !== undefined) return direct[1]
	}
	throw new CloneFailure(
		'REF_RESOLUTION_FAILED',
		'GitHub repository did not advertise a default HEAD.',
	)
}

async function fetchSnapshot(
	runtime: GitRuntime,
	target: string,
	requestedRef: string | undefined,
): Promise<string> {
	const ref =
		requestedRef ??
		parseDefaultHead(
			await git(runtime, target, 'default branch resolution', [
				'ls-remote',
				'--symref',
				'origin',
				'HEAD',
			]),
		)
	await git(runtime, target, 'snapshot fetch', ['fetch', '--depth=1', '--no-tags', 'origin', ref])
	const commit = await git(runtime, target, 'fetched commit resolution', [
		'rev-parse',
		'FETCH_HEAD^{commit}',
	])
	if (!/^[0-9a-f]{40,64}$/u.test(commit)) {
		throw new CloneFailure('REF_RESOLUTION_FAILED', 'Git returned an invalid resolved commit SHA.')
	}
	return commit
}

async function checkoutSnapshot(
	runtime: GitRuntime,
	target: string,
	commit: string,
): Promise<void> {
	await git(runtime, target, 'snapshot checkout', ['checkout', '--detach', '--force', commit])
}

function repoFromGitHubPath(pathname: string): string {
	let decoded: string
	try {
		decoded = decodeURIComponent(pathname)
	} catch {
		throw new CloneFailure('SUBMODULE_URL_REJECTED', 'Submodule URL contains invalid encoding.')
	}
	const segments = decoded.replace(/^\/+|\/+$/gu, '').split('/')
	if (segments.length !== 2 || segments[0] === undefined || segments[1] === undefined) {
		throw new CloneFailure(
			'SUBMODULE_URL_REJECTED',
			'Submodule URL is not a GitHub owner/repository path.',
		)
	}
	return normalizeRepo(`${segments[0]}/${segments[1].replace(/\.git$/iu, '')}`)
}

export function resolveGitHubSubmoduleUrl(rawUrl: string, parentRepo: string): string {
	const value = rawUrl.trim()
	if (value.length === 0 || /[\r\n]/u.test(value)) {
		throw new CloneFailure('SUBMODULE_URL_REJECTED', 'Submodule URL is empty or malformed.')
	}

	if (value.startsWith('./') || value.startsWith('../')) {
		const relative = path.posix.normalize(
			path.posix.join(`/${normalizeRepo(parentRepo)}.git`, value),
		)
		return cleanRemoteUrl(repoFromGitHubPath(relative))
	}

	const scp = /^(?:git@)?github\.com:([^?#]+)$/iu.exec(value)
	if (scp?.[1] !== undefined) return cleanRemoteUrl(repoFromGitHubPath(scp[1]))

	let parsed: URL
	try {
		parsed = new URL(value)
	} catch {
		throw new CloneFailure('SUBMODULE_URL_REJECTED', 'Submodule URL is not a supported GitHub URL.')
	}
	if (
		!['https:', 'ssh:'].includes(parsed.protocol) ||
		parsed.hostname.toLowerCase() !== 'github.com' ||
		parsed.port.length > 0 ||
		parsed.search.length > 0 ||
		parsed.hash.length > 0
	) {
		throw new CloneFailure(
			'SUBMODULE_URL_REJECTED',
			'Submodules must use HTTPS, SSH, scp-style, or relative URLs hosted on github.com.',
		)
	}
	return cleanRemoteUrl(repoFromGitHubPath(parsed.pathname))
}

function submoduleRepo(cleanUrl: string): string {
	return repoFromGitHubPath(new URL(cleanUrl).pathname)
}

async function assertNoSymlinkPath(root: string, relativePath: string): Promise<string> {
	if (
		path.isAbsolute(relativePath) ||
		relativePath.includes('\\') ||
		relativePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
	) {
		throw new CloneFailure('SUBMODULE_PATH_REJECTED', 'Submodule path is not safely contained.')
	}
	const target = path.resolve(root, relativePath)
	if (!pathIsInside(root, target) || target === path.resolve(root)) {
		throw new CloneFailure('SUBMODULE_PATH_REJECTED', 'Submodule path escapes its parent checkout.')
	}

	let current = path.resolve(root)
	for (const segment of relativePath.split('/')) {
		current = path.join(current, segment)
		const state = await pathState(current)
		if (state === 'symlink') {
			throw new CloneFailure('SUBMODULE_PATH_REJECTED', 'Submodule path traverses a symbolic link.')
		}
		if (state === 'missing') break
	}
	return target
}

async function gitmoduleKeys(
	runtime: GitRuntime,
	repositoryPath: string,
): Promise<ReadonlyArray<string>> {
	if ((await pathState(path.join(repositoryPath, '.gitmodules'))) === 'missing') return []
	const result = await runGit(
		runtime,
		[
			'config',
			'--null',
			'--file',
			'.gitmodules',
			'--name-only',
			'--get-regexp',
			'^submodule\\..*\\.path$',
		],
		repositoryPath,
	)
	if (!result.ok && result.exitCode === 1 && result.stdout.trim().length === 0) return []
	if (!result.ok) {
		const detail = trimmed(result.stderr) ?? 'Git exited without output.'
		throw new CloneFailure(
			'SUBMODULE_CONFIG_INVALID',
			`Git submodule declaration inspection failed: ${detail}`,
		)
	}
	return result.stdout.split('\0').filter((key) => key.length > 0)
}

async function initializeSubmodules(
	runtime: GitRuntime,
	config: GitHubConfig,
	repositoryPath: string,
	repositoryRepo: string,
	entries: Array<GitHubSubmodule>,
	ancestorCommits: ReadonlySet<string>,
	depth = 1,
	prefix = '',
): Promise<void> {
	if (depth > MAX_SUBMODULE_DEPTH) {
		throw new CloneFailure(
			'SUBMODULE_INIT_FAILED',
			`Submodule nesting exceeds ${MAX_SUBMODULE_DEPTH}.`,
		)
	}

	for (const key of await gitmoduleKeys(runtime, repositoryPath)) {
		const match = /^submodule\.(.+)\.path$/u.exec(key)
		if (match?.[1] === undefined) {
			throw new CloneFailure(
				'SUBMODULE_CONFIG_INVALID',
				'Submodule declaration has an invalid key.',
			)
		}
		const name = match[1]
		const subPath = await git(runtime, repositoryPath, 'submodule path inspection', [
			'config',
			'--file',
			'.gitmodules',
			'--get',
			key,
		])
		const rawUrl = await git(runtime, repositoryPath, 'submodule URL inspection', [
			'config',
			'--file',
			'.gitmodules',
			'--get',
			`submodule.${name}.url`,
		])
		const submodulePath = await assertNoSymlinkPath(repositoryPath, subPath)
		let cleanUrl: string
		let repo: string
		try {
			cleanUrl = resolveGitHubSubmoduleUrl(rawUrl, repositoryRepo)
			repo = assertConfiguredRepo(submoduleRepo(cleanUrl), config)
		} catch (error) {
			throw error instanceof CloneFailure
				? error
				: new CloneFailure('SUBMODULE_URL_REJECTED', describeUnknown(error))
		}

		await git(runtime, repositoryPath, 'submodule URL rewrite', [
			'config',
			'--local',
			`submodule.${name}.url`,
			cleanUrl,
		])
		await git(runtime, repositoryPath, 'submodule update strategy configuration', [
			'config',
			'--local',
			`submodule.${name}.update`,
			'checkout',
		])
		await git(runtime, repositoryPath, 'shallow submodule initialization', [
			'submodule',
			'update',
			'--init',
			'--depth=1',
			'--recommend-shallow',
			'--',
			subPath,
		])
		if ((await pathState(submodulePath)) !== 'directory') {
			throw new CloneFailure('SUBMODULE_INIT_FAILED', 'Git did not create the submodule directory.')
		}
		const realParent = await realpath(repositoryPath)
		const realSubmodule = await realpath(submodulePath)
		if (!pathIsInside(realParent, realSubmodule) || realParent === realSubmodule) {
			throw new CloneFailure('SUBMODULE_PATH_REJECTED', 'Initialized submodule escapes its parent.')
		}
		await validateCheckout(runtime, submodulePath, cleanUrl)
		const commit = await git(runtime, submodulePath, 'submodule commit resolution', [
			'rev-parse',
			'HEAD^{commit}',
		])
		const cycleKey = `${repo}@${commit}`
		if (ancestorCommits.has(cycleKey)) {
			throw new CloneFailure('SUBMODULE_INIT_FAILED', 'Transitive submodule cycle detected.')
		}
		const displayPath = prefix.length === 0 ? subPath : `${prefix}/${subPath}`
		entries.push({ path: displayPath, repo, url: cleanUrl, commit, depth })
		await initializeSubmodules(
			runtime,
			config,
			submodulePath,
			repo,
			entries,
			new Set([...ancestorCommits, cycleKey]),
			depth + 1,
			displayPath,
		)
	}
}

async function createCheckout(
	runtime: GitRuntime,
	config: GitHubConfig,
	root: string,
	target: string,
	repo: string,
	requestedRef: string | undefined,
	entries: Array<GitHubSubmodule>,
): Promise<string> {
	const staging = path.join(root, `${path.basename(target)}.staging-${randomUUID()}`)
	let published = false
	try {
		await mkdir(staging)
		await git(runtime, staging, 'repository initialization', ['init', '--quiet'])
		await git(runtime, staging, 'origin configuration', [
			'remote',
			'add',
			'origin',
			cleanRemoteUrl(repo),
		])
		const commit = await fetchSnapshot(runtime, staging, requestedRef)
		await checkoutSnapshot(runtime, staging, commit)
		try {
			await initializeSubmodules(
				runtime,
				config,
				staging,
				repo,
				entries,
				new Set([`${repo}@${commit}`]),
			)
		} catch (error) {
			const gap = describeUnknown(error)
			throw new CloneFailure(
				error instanceof CloneFailure ? error.code : 'SUBMODULE_INIT_FAILED',
				gap,
				{
					complete: false,
					entries,
					gaps: [gap],
				},
			)
		}
		if ((await pathState(target)) !== 'missing') {
			throw new CloneFailure(
				'TARGET_COLLISION',
				'Managed checkout target appeared during creation.',
			)
		}
		await rename(staging, target)
		published = true
		return commit
	} finally {
		if (!published) await rm(staging, { recursive: true, force: true })
	}
}

async function updateCheckout(
	runtime: GitRuntime,
	config: GitHubConfig,
	target: string,
	repo: string,
	requestedRef: string | undefined,
	entries: Array<GitHubSubmodule>,
): Promise<string> {
	await validateCheckout(runtime, target, cleanRemoteUrl(repo))
	await assertClean(runtime, target)
	const commit = await fetchSnapshot(runtime, target, requestedRef)
	await assertClean(runtime, target)
	await checkoutSnapshot(runtime, target, commit)
	try {
		await initializeSubmodules(
			runtime,
			config,
			target,
			repo,
			entries,
			new Set([`${repo}@${commit}`]),
		)
	} catch (error) {
		const gap = describeUnknown(error)
		throw new CloneFailure(
			error instanceof CloneFailure ? error.code : 'SUBMODULE_INIT_FAILED',
			gap,
			{
				complete: false,
				entries,
				gaps: [gap],
			},
		)
	}
	return commit
}

async function serializeTarget<T>(target: string, action: () => Promise<T>): Promise<T> {
	const previous = targetQueues.get(target) ?? Promise.resolve()
	const current = previous.catch(() => undefined).then(action)
	targetQueues.set(target, current)
	try {
		return await current
	} finally {
		if (targetQueues.get(target) === current) targetQueues.delete(target)
	}
}

async function githubCloneRequest(
	config: GitHubConfig,
	input: GitHubCloneInput,
	context: ToolContext,
	options: GitHubCloneOptions,
): Promise<GitHubCloneResult> {
	let repo: string | undefined
	let requestedRef: string | undefined
	try {
		const normalizedRepo = assertConfiguredRepo(input.repo, config)
		repo = normalizedRepo
		requestedRef = validateRef(input.ref)
		const root = await ensureManagedRoot(context.worktree)
		const target = path.join(root, cloneDirectoryName(normalizedRepo, requestedRef))
		const runtime = await makeRuntime(config, context, options)
		return await serializeTarget(target, async () => {
			if (runtime.signal.aborted) throw new CloneFailure('ABORTED', 'GitHub clone was aborted.')
			const entries: Array<GitHubSubmodule> = []
			const existing = await pathState(target)
			const state = existing === 'missing' ? 'created' : 'updated'
			const resolvedCommit =
				existing === 'missing'
					? await createCheckout(
							runtime,
							config,
							root,
							target,
							normalizedRepo,
							requestedRef,
							entries,
						)
					: await updateCheckout(runtime, config, target, normalizedRepo, requestedRef, entries)
			const relativePath = path
				.relative(path.resolve(context.worktree), target)
				.split(path.sep)
				.join('/')
			return {
				ok: true,
				repo: normalizedRepo,
				relativePath,
				absolutePath: target,
				...optionalField('requestedRef', requestedRef),
				resolvedCommit,
				state,
				lfsObjectsMaterialized: false,
				submodules: { complete: true, entries },
			}
		})
	} catch (error) {
		const failure =
			error instanceof CloneFailure
				? error
				: new CloneFailure('GITHUB_CLONE_FAILED', describeUnknown(error))
		return {
			ok: false,
			...optionalField('repo', repo),
			...optionalField('requestedRef', requestedRef),
			error: { code: failure.code, message: failure.message },
			...(failure.submodules === undefined ? {} : { submodules: failure.submodules }),
		}
	}
}

export const githubClone = Effect.fn(function* githubClone(
	config: GitHubConfig,
	input: GitHubCloneInput,
	context: ToolContext,
	options: GitHubCloneOptions = {},
) {
	return yield* Effect.tryPromise({
		try: () => githubCloneRequest(config, input, context, options),
		catch: (error) =>
			new ToolInputError({
				tool: 'github_clone',
				message: describeUnknown(error),
			}),
	})
})
