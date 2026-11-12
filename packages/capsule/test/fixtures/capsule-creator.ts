import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Schema } from 'effect'
import { RuntimeSettings } from '../../src/schema'
import { make } from '../../src/service'
import { SourceRequest } from '../../src/source/schema'

/**
 * The JSON argument of this standalone creator, which runs `Capsule.create` in its own process so a
 * test can kill it mid-creation. Remotes resolve to `<remote><owner/repo>.git`.
 */
export const CreatorInput = Schema.Struct({
	root: Schema.String,
	checkoutRoot: Schema.String,
	runtime: RuntimeSettings,
	remote: Schema.String,
	request: SourceRequest,
})

const create = Effect.gen(function* () {
	const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CreatorInput))(
		process.argv[2] ?? '',
	)
	const capsule = yield* make({
		root: input.root,
		checkoutRoot: input.checkoutRoot,
		runtime: input.runtime,
		repositoryUrl: (repository) => `${input.remote}${repository}.git`,
	})
	yield* capsule.create(input.request)
})

NodeRuntime.runMain(create.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
