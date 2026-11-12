import { Effect, Predicate } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { CapsuleError } from '../schema'
import { Capsule } from '../service'
import { bindingOf, matchesBinding } from './binding'

interface WorkspaceInput {
	readonly workspaceID: string
}

interface BindingInput extends WorkspaceInput {
	readonly binding: unknown
}

/**
 * Attaches OpenCode workspaces to Capsules prepared beforehand under the workspace ID. `fail`
 * builds the host's own driver error, so OpenCode SDK and native hosts share this implementation.
 */
export const makeDriver = Effect.fn('CapsuleWorkspace.makeDriver')(function* <E>(
	fail: (message: string) => E,
) {
	const capsule = yield* Capsule

	const create = Effect.fn('CapsuleWorkspace.create')(
		function* ({ workspaceID }: WorkspaceInput) {
			const manifest = yield* capsule.inspect(workspaceID)
			if (manifest?.phase !== 'ready') {
				return yield* CapsuleError.make({
					code: 'not_prepared',
					message: 'Prepare the Capsule before provisioning its workspace.',
				})
			}
			return { binding: bindingOf(manifest) }
		},
		Effect.mapError(failure('attach', fail)),
	)

	const connect = Effect.fn('CapsuleWorkspace.connect')(
		function* ({ workspaceID, binding }: BindingInput) {
			const manifest = yield* capsule.inspect(workspaceID)
			if (!manifest || manifest.spec.id !== workspaceID || !matchesBinding(binding, manifest)) {
				return yield* CapsuleError.make({
					code: 'ownership_mismatch',
					message: 'The Capsule binding does not match its persisted state.',
				})
			}
			const spawner = yield* capsule.connect(workspaceID)
			return {
				spawner: ChildProcessSpawner.make((command) => spawner.spawn(inheritEnvironment(command))),
			}
		},
		Effect.mapError(failure('connect', fail)),
	)

	const destroy = Effect.fn('CapsuleWorkspace.destroy')(
		function* ({ workspaceID }: WorkspaceInput) {
			yield* capsule.purge(workspaceID)
		},
		Effect.mapError(failure('purge', fail)),
	)

	return {
		create,
		connect,
		// Commands hold no connection between spawns, and retained project services outlive idleness.
		suspendForIdle: (_: BindingInput) => Effect.void,
		destroy,
	}
})

// In a workspace, OpenCode omits its host environment and passes only overrides such as `TERM`,
// expecting them to extend the workspace's own environment: here, the project's development shell.
const inheritEnvironment = (command: ChildProcess.Command): ChildProcess.Command => {
	if (ChildProcess.isPipedCommand(command)) {
		const left = inheritEnvironment(command.left)
		return ChildProcess.pipeTo(left, inheritEnvironment(command.right), command.options)
	}
	if (command.options.env === undefined) return command
	return ChildProcess.make(command.command, command.args, { ...command.options, extendEnv: true })
}

// Driver errors reach OpenCode's logs and clients, so only Capsule's own messages pass through.
const failure =
	<E>(operation: string, fail: (message: string) => E) =>
	(error: unknown) => {
		if (error instanceof CapsuleError) return fail(`Capsule ${operation} failed: ${error.message}`)
		const tag =
			Predicate.hasProperty(error, '_tag') && Predicate.isString(error._tag)
				? ` (${error._tag})`
				: ''
		return fail(`Capsule ${operation} failed${tag}.`)
	}
