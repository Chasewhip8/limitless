import { Console, Effect, Option } from 'effect'
import { Command, Flag } from 'effect/cli'
import { CapsuleId } from '../identity'
import { CommitSha, RefName, Repository } from '../source/schema'
import { service } from './context'

export const create = Command.make(
	'create',
	{
		id: Flag.String('id').pipe(Flag.withSchema(CapsuleId)),
		repository: Flag.String('repo').pipe(
			Flag.withSchema(Repository),
			Flag.withDescription('GitHub source repository, configured as origin and its push URL.'),
		),
		ref: Flag.String('ref').pipe(
			Flag.withSchema(RefName),
			Flag.withDescription('Initial branch name, tag name, or full commit SHA; resolved once.'),
		),
		branch: Flag.String('branch').pipe(
			Flag.withSchema(RefName),
			Flag.withDescription('Local work branch; defaults to capsule-<id>.'),
			Flag.optional,
		),
		commit: Flag.String('commit').pipe(
			Flag.withSchema(CommitSha),
			Flag.withDescription('Require the initial ref to resolve to this commit.'),
			Flag.optional,
		),
		dockerSocket: Flag.String('docker-socket').pipe(
			Flag.withDescription('Existing host Docker Unix socket to expose.'),
			Flag.optional,
		),
		refresh: Flag.Boolean('refresh').pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				'Refresh the retained environment and setup, without resetting Git work.',
			),
		),
	},
	Effect.fn('CapsuleCli.create')(function* ({
		id,
		repository,
		ref,
		branch,
		commit,
		dockerSocket,
		refresh,
	}) {
		const capsule = yield* service()
		const result = yield* capsule.create(
			{
				id,
				repository,
				ref,
				branch: Option.getOrElse(branch, () => `capsule-${id}`),
				...(Option.isSome(commit) ? { commit: commit.value } : {}),
			},
			{
				refresh,
				...(Option.isSome(dockerSocket) ? { dockerSocket: dockerSocket.value } : {}),
			},
		)
		yield* Console.log(JSON.stringify(result))
	}),
).pipe(
	Command.withDescription(
		'Create or resume a managed full clone, then prepare its Nix environment.',
	),
)
