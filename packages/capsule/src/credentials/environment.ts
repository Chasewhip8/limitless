import { Redacted } from 'effect'
import { ChildProcess } from 'effect/process'

export type EnvironmentValue = string | Redacted.Redacted<string>
type EnvironmentOverrides = Readonly<Record<string, EnvironmentValue | undefined>>

/**
 * One execution's credential policy. Apply it last, after the cached project environment and
 * command overrides, with {@link applyCredentials} or {@link credentialOverrides}.
 */
export interface CredentialEnvironment {
	/** Undefined values remove the variable. */
	readonly variables: EnvironmentOverrides
	/** Command-scoped Git configuration that takes precedence over every configuration file. */
	readonly gitConfig: ReadonlyArray<readonly [key: string, value: string]>
}

const helperKey = 'credential.https://github.com.helper'
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

// An empty helper clears helpers from configuration files and the private home, so the pinned
// CLI is the only helper Git consults for GitHub.
export const gitHubHelper = (gh: string) =>
	[
		[helperKey, ''],
		[helperKey, `!${quote(gh)} auth git-credential`],
	] as const

const text = (value: EnvironmentValue | undefined) =>
	Redacted.isRedacted(value) ? Redacted.value(value) : value

const configEntry = /^GIT_CONFIG_(?:KEY|VALUE)_(\d+)$/

// Git fails on a malformed GIT_CONFIG_COUNT or a missing entry, so only the well-formed prefix of
// prior entries survives and credential entries follow it.
const priorGitConfigCount = (environment: EnvironmentOverrides) => {
	const declared = Number(text(environment.GIT_CONFIG_COUNT) ?? '0')
	if (!Number.isSafeInteger(declared) || declared < 0) return 0
	let count = 0
	while (
		count < declared &&
		environment[`GIT_CONFIG_KEY_${count}`] !== undefined &&
		environment[`GIT_CONFIG_VALUE_${count}`] !== undefined
	)
		count++
	return count
}

const gitConfigOverrides = (
	environment: EnvironmentOverrides,
	entries: CredentialEnvironment['gitConfig'],
) => {
	const overrides: Record<string, string | undefined> = {}
	if (entries.length === 0) return overrides
	const start = priorGitConfigCount(environment)
	const count = start + entries.length
	for (const name of Object.keys(environment)) {
		const index = configEntry.exec(name)?.[1]
		if (index !== undefined && Number(index) >= count) overrides[name] = undefined
	}
	entries.forEach(([key, value], offset) => {
		overrides[`GIT_CONFIG_KEY_${start + offset}`] = key
		overrides[`GIT_CONFIG_VALUE_${start + offset}`] = value
	})
	overrides.GIT_CONFIG_COUNT = String(count)
	return overrides
}

/**
 * The variables to set or remove so a command whose effective environment is `environment`
 * receives `credentials`. Undefined values remove the variable.
 */
export const credentialOverrides = (
	environment: EnvironmentOverrides,
	credentials: CredentialEnvironment,
): EnvironmentOverrides => ({
	...gitConfigOverrides(environment, credentials.gitConfig),
	...credentials.variables,
})

/** Returns the complete environment with credentials applied over `environment`. */
export const applyCredentials = (
	environment: EnvironmentOverrides,
	credentials: CredentialEnvironment,
) => {
	const applied: Record<string, EnvironmentValue> = {}
	for (const [name, value] of Object.entries({
		...environment,
		...credentialOverrides(environment, credentials),
	}))
		if (value !== undefined) applied[name] = value
	return applied
}

/**
 * Applies credentials to every stage of `command`, preserving whether each stage inherits or
 * replaces its spawner's environment. `inherited` is what inheriting stages receive.
 */
export const withCredentials = (
	command: ChildProcess.Command,
	inherited: EnvironmentOverrides,
	credentials: CredentialEnvironment,
): ChildProcess.Command => {
	switch (command._tag) {
		case 'StandardCommand': {
			const { env, extendEnv } = command.options
			const inherits = env === undefined || extendEnv === true
			const effective = inherits ? { ...inherited, ...env } : { ...env }
			return ChildProcess.make(command.command, command.args, {
				...command.options,
				env: { ...env, ...credentialOverrides(effective, credentials) },
				extendEnv: inherits ? true : extendEnv,
			})
		}
		case 'PipedCommand':
			return ChildProcess.pipeTo(
				withCredentials(command.left, inherited, credentials),
				withCredentials(command.right, inherited, credentials),
				command.options,
			)
	}
}
