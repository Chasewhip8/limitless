import { Schema } from 'effect'
import { AbsolutePath } from '../identity'

const VariableName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/))
const IdentityText = Schema.String.check(Schema.isPattern(/^[^\p{Cc}<>]+$/u))

export const GitHubToken = Schema.Redacted(Schema.String.check(Schema.isPattern(/^[!-~]+$/)))

export const GitHubCredentials = Schema.Struct({
	tokenFile: Schema.optionalKey(
		AbsolutePath.annotate({
			description:
				'A host file holding the GitHub token, reread for every command so rotation applies without a restart.',
		}),
	),
	tokenEnv: Schema.optionalKey(
		VariableName.annotate({
			description:
				"A variable in the hosting process's configuration holding the GitHub token. Without either source, GH_TOKEN and then GITHUB_TOKEN are used. Changes require a restart.",
		}),
	),
}).check(
	Schema.makeFilter(
		(github) =>
			github.tokenFile === undefined ||
			github.tokenEnv === undefined ||
			'Configure either tokenFile or tokenEnv, not both',
	),
)

export const GitIdentity = Schema.Struct({
	name: IdentityText,
	email: IdentityText,
})

export const CredentialsOptions = Schema.Struct({
	github: Schema.optionalKey(
		GitHubCredentials.annotate({
			description:
				'Host-authorized GitHub access for trusted agents. Without it, commands receive no host credentials.',
		}),
	),
	identity: Schema.optionalKey(
		GitIdentity.annotate({
			description: 'The author and committer identity Git uses inside the Capsule.',
		}),
	),
})
export type CredentialsOptions = typeof CredentialsOptions.Type

/** Messages never contain token material. */
export class CredentialsError extends Schema.TaggedError<CredentialsError>()(
	'CapsuleCredentialsError',
	{
		reason: Schema.Literals(['invalid_options', 'token_unreadable', 'token_invalid']),
		message: Schema.String,
	},
) {}
