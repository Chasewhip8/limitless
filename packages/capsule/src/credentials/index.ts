import {
	Config,
	ConfigProvider,
	Effect,
	FileSystem,
	Option,
	Path,
	PlatformError,
	Redacted,
	Schema,
} from 'effect'
import { ChildProcessSpawner } from 'effect/process'
import {
	type CredentialEnvironment,
	type EnvironmentValue,
	gitHubHelper,
	withCredentials,
} from './environment'
import {
	CredentialsError,
	CredentialsOptions,
	type GitHubCredentials,
	GitHubToken,
} from './options'

export {
	applyCredentials,
	type CredentialEnvironment,
	credentialOverrides,
	withCredentials,
} from './environment'
export { CredentialsError, CredentialsOptions, GitHubCredentials, GitIdentity } from './options'

const maximumTokenBytes = 65_536n
const defaultTokenVariables = ['GH_TOKEN', 'GITHUB_TOKEN'] as const

const decodeToken = (token: Redacted.Redacted<string>, source: string) =>
	Schema.decodeEffect(GitHubToken)(token).pipe(
		Effect.mapError(() =>
			CredentialsError.make({
				reason: 'token_invalid',
				message: `${source} does not hold a valid GitHub token.`,
			}),
		),
	)

const invalidOptions = (message: string) =>
	CredentialsError.make({ reason: 'invalid_options', message })

/**
 * Makes the host-authorized credential policy for Capsule commands. `gh` is the pinned GitHub CLI
 * that Git runs as its credential helper for https://github.com; it must be visible at the same
 * path inside the sandbox. Configure credentials from host configuration, never from a
 * repository.
 */
export const makeCredentials = Effect.fn('CapsuleCredentials.make')(function* (
	input: typeof CredentialsOptions.Encoded,
	gh: string,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const provider = yield* ConfigProvider.ConfigProvider

	const options = yield* Schema.decodeUnknownEffect(CredentialsOptions)(input).pipe(
		Effect.mapError(() =>
			invalidOptions(
				'The credential options are invalid; GitHub needs at most one absolute token file or variable name, and an identity needs a name and email.',
			),
		),
	)
	const { github, identity } = options
	if (github !== undefined) {
		const locations = github.tokenFile === undefined ? [gh] : [gh, github.tokenFile]
		for (const location of locations) {
			if (!path.isAbsolute(location) || path.resolve(location) !== location)
				return yield* invalidOptions(`The path ${location} must be absolute and normalized.`)
		}
		yield* fs
			.access(gh)
			.pipe(Effect.mapError(() => invalidOptions(`The GitHub CLI ${gh} is not accessible.`)))
	}

	const readTokenFile = Effect.fn('CapsuleCredentials.readTokenFile')(function* (file: string) {
		const source = `The GitHub token file ${file}`
		const unreadable = () =>
			CredentialsError.make({ reason: 'token_unreadable', message: `${source} is unreadable.` })
		const info = yield* fs.stat(file).pipe(Effect.mapError(unreadable))
		if (info.type !== 'File' || info.size > maximumTokenBytes) {
			return yield* CredentialsError.make({
				reason: 'token_invalid',
				message: `${source} must be a regular file of at most 64 KiB.`,
			})
		}
		const content = yield* fs.readFileString(file).pipe(Effect.mapError(unreadable))
		return yield* decodeToken(Redacted.make(content.trim()), source)
	})

	const readTokenVariable = Effect.fn('CapsuleCredentials.readTokenVariable')(function* (
		name: string,
	) {
		const token = yield* Config.option(Config.Redacted(name))
			.parse(provider)
			.pipe(
				Effect.mapError(() =>
					CredentialsError.make({
						reason: 'token_unreadable',
						message: `The GitHub token variable ${name} is unreadable.`,
					}),
				),
			)
		if (Option.isNone(token)) return undefined
		return yield* decodeToken(token.value, `The GitHub token variable ${name}`)
	})

	const readToken = Effect.fn('CapsuleCredentials.readToken')(function* (
		source: typeof GitHubCredentials.Type,
	) {
		if (source.tokenFile !== undefined) return yield* readTokenFile(source.tokenFile)
		if (source.tokenEnv !== undefined) return yield* readTokenVariable(source.tokenEnv)
		for (const name of defaultTokenVariables) {
			const token = yield* readTokenVariable(name)
			if (token !== undefined) return token
		}
		return undefined
	})

	const identityVariables: Record<string, string> =
		identity === undefined
			? {}
			: {
					GIT_AUTHOR_NAME: identity.name,
					GIT_AUTHOR_EMAIL: identity.email,
					GIT_COMMITTER_NAME: identity.name,
					GIT_COMMITTER_EMAIL: identity.email,
				}
	const gitConfig = github === undefined ? [] : gitHubHelper(gh)

	const environment = Effect.fn('CapsuleCredentials.environment')(function* () {
		const token = github === undefined ? undefined : yield* readToken(github)
		const variables: Record<string, EnvironmentValue | undefined> = {
			GITHUB_TOKEN: undefined,
			GH_ENTERPRISE_TOKEN: undefined,
			GITHUB_ENTERPRISE_TOKEN: undefined,
			GH_TOKEN: token,
			GH_PROMPT_DISABLED: '1',
			GIT_TERMINAL_PROMPT: '0',
			...identityVariables,
		}
		return { variables, gitConfig } satisfies CredentialEnvironment
	})

	/**
	 * Applies fresh credentials to every command `spawner` runs. `inherited` is the environment
	 * `spawner` gives commands that do not replace it, such as the cached project environment; Git
	 * configuration entries are numbered after its own.
	 */
	const decorate = (
		spawner: ChildProcessSpawner.ChildProcessSpawner['Service'],
		inherited: Readonly<Record<string, EnvironmentValue | undefined>> = {},
	) =>
		ChildProcessSpawner.make(
			Effect.fn('CapsuleCredentials.spawn')(function* (command) {
				const credentials = yield* environment().pipe(
					Effect.mapError((error) =>
						PlatformError.systemError({
							_tag: error.reason === 'token_unreadable' ? 'PermissionDenied' : 'InvalidData',
							module: 'Capsule',
							method: 'spawn',
							description: error.message,
							cause: error,
						}),
					),
				)
				return yield* spawner.spawn(withCredentials(command, inherited, credentials))
			}),
		)

	return { environment: environment(), decorate }
})

export type Credentials = Effect.Success<ReturnType<typeof makeCredentials>>
