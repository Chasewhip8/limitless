import { Config, Effect, FileSystem, Option, Schema } from 'effect'
import { Argument, Command, Flag } from 'effect/cli'
import { CapsuleError, CapsuleId, RuntimeSettings } from '../schema'
import { make } from '../service'

const optionalSetting = (name: string, variable: string, description: string) =>
	Flag.String(name).pipe(
		Flag.withFallbackConfig(Config.String(variable)),
		Flag.withDescription(description),
		Flag.optional,
	)

export const root = Command.make('capsule').pipe(
	Command.withSharedFlags({
		root: Flag.String('root').pipe(
			Flag.withFallbackConfig(Config.String('CAPSULE_ROOT')),
			Flag.withDescription('Dedicated absolute state directory, outside every source checkout.'),
		),
		runtime: Flag.String('runtime').pipe(
			Flag.withFallbackConfig(Config.String('CAPSULE_RUNTIME_CONFIG')),
			Flag.withDescription('Pinned runtime JSON supplied by the Capsule Nix package.'),
		),
		checkoutRoot: optionalSetting(
			'checkout-root',
			'CAPSULE_CHECKOUT_ROOT',
			'Dedicated root for managed Git checkouts; required by create and separate from runtime state.',
		),
		tokenFile: optionalSetting(
			'github-token-file',
			'CAPSULE_GITHUB_TOKEN_FILE',
			'Host token file, read for each execution; never copied into Capsule state or Nix configuration.',
		),
		tokenEnv: optionalSetting(
			'github-token-env',
			'CAPSULE_GITHUB_TOKEN_ENV',
			'Host token variable; without a configured file or variable, use GH_TOKEN then GITHUB_TOKEN.',
		),
		gitName: optionalSetting('git-name', 'CAPSULE_GIT_NAME', 'Git author and committer name.'),
		gitEmail: optionalSetting('git-email', 'CAPSULE_GIT_EMAIL', 'Git author and committer email.'),
	}),
	Command.withDescription('Prepare and execute retained Nix workspaces through Bubblewrap.'),
)

export const service = Effect.fn('CapsuleCli.service')(function* () {
	const options = yield* root
	const fs = yield* FileSystem.FileSystem
	const json = yield* fs.readFileString(options.runtime)
	const runtime = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeSettings))(
		json,
	).pipe(
		Effect.mapError(() =>
			CapsuleError.make({
				code: 'invalid_input',
				message: 'Invalid Capsule runtime configuration.',
			}),
		),
	)
	if (Option.isSome(options.gitName) !== Option.isSome(options.gitEmail)) {
		return yield* CapsuleError.make({
			code: 'invalid_input',
			message: 'Configure both the Git name and email, or neither.',
		})
	}
	return yield* make({
		root: options.root,
		runtime,
		...(Option.isSome(options.checkoutRoot) ? { checkoutRoot: options.checkoutRoot.value } : {}),
		credentials: {
			github: {
				...(Option.isSome(options.tokenFile) ? { tokenFile: options.tokenFile.value } : {}),
				...(Option.isSome(options.tokenEnv) ? { tokenEnv: options.tokenEnv.value } : {}),
			},
			...(Option.isSome(options.gitName) && Option.isSome(options.gitEmail)
				? { identity: { name: options.gitName.value, email: options.gitEmail.value } }
				: {}),
		},
	})
})

export const idArgument = Argument.String('id').pipe(Argument.withSchema(CapsuleId))
