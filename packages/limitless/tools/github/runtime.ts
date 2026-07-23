import { readFile } from 'node:fs/promises'
import { Effect, PartitionedSemaphore, Schema } from 'effect'
import { objectProperty } from '../../lib/guards'
import { type GitConfigEntry, GitHubCloneOptions } from './clone-schema'
import type { GitHubConfig } from './config'
import { cloneFailure } from './errors'
import { trimmed } from './repository'

export const GIT_BIN = '@GIT_BIN@'
export const DEFAULT_GIT_TIMEOUT_MS = 120_000

export type GitRuntime = {
	readonly gitBin: string
	readonly timeoutMs: number
	readonly env: Readonly<Record<string, string | undefined>>
	readonly secrets: ReadonlyArray<string>
}

export type GitHubCloneRuntime = {
	readonly targetSemaphore: PartitionedSemaphore.PartitionedSemaphore<string>
}

export const makeGitHubCloneRuntime = Effect.fn('makeGitHubCloneRuntime')(function* () {
	const targetSemaphore = yield* PartitionedSemaphore.make<string>({ permits: 1 })
	return { targetSemaphore } satisfies GitHubCloneRuntime
})

const configuredToken = Effect.fn('configuredToken')(function* (config: GitHubConfig) {
	if (config.tokenFile !== undefined) {
		const tokenFile = config.tokenFile
		const token = yield* Effect.tryPromise({
			try: (signal) => readFile(tokenFile, { encoding: 'utf8', signal }),
			catch: (error) => {
				const code = objectProperty(error, 'code')
				return cloneFailure(
					'TOKEN_READ_FAILED',
					`Failed to read configured GitHub token file${typeof code === 'string' ? ` (${code})` : ''}.`,
				)
			},
		})
		return trimmed(token)
	}
	return yield* Effect.sync(() => trimmed(process.env[config.tokenEnv]))
})

const gitEnvironment = Effect.fn('gitEnvironment')(function* (
	token: string | undefined,
	extraConfig: ReadonlyArray<GitConfigEntry>,
) {
	if (token !== undefined && /[\r\n]/u.test(token)) {
		return yield* cloneFailure('INVALID_TOKEN', 'GitHub token cannot contain line breaks.')
	}
	const authorization =
		token === undefined
			? undefined
			: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`
	const entries: Array<GitConfigEntry> = [
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
		GIT_CONFIG_COUNT: String(entries.length),
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_LFS_SKIP_SMUDGE: '1',
		GIT_TERMINAL_PROMPT: '0',
	}
	for (const [index, entry] of entries.entries()) {
		env[`GIT_CONFIG_KEY_${index}`] = entry.key
		env[`GIT_CONFIG_VALUE_${index}`] = entry.value
	}
	return {
		env,
		secrets: [token, authorization].filter((value): value is string => value !== undefined),
	}
})

export const makeGitRuntime = Effect.fn('makeGitRuntime')(function* (
	config: GitHubConfig,
	options: GitHubCloneOptions,
) {
	const decodedOptions = yield* Schema.decodeUnknownEffect(GitHubCloneOptions)(options).pipe(
		Effect.mapError((error) =>
			cloneFailure('GITHUB_CLONE_FAILED', `Invalid clone options: ${error}`),
		),
	)
	const auth = yield* configuredToken(config).pipe(
		Effect.flatMap((token) => gitEnvironment(token, decodedOptions.gitConfig ?? [])),
	)
	return {
		gitBin: decodedOptions.gitBin ?? GIT_BIN,
		timeoutMs: decodedOptions.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
		env: { ...auth.env, [config.tokenEnv]: undefined },
		secrets: auth.secrets,
	} satisfies GitRuntime
})
