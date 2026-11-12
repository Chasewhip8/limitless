import { WorkspaceDriver } from '@opencode/sdk/effect'
import { Effect, Predicate, Schema } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { AbsolutePath, CapsuleError, CapsuleId, type CapsuleSpec } from './schema'
import { Capsule } from './service'

export interface WorkspaceOptions<E, R> {
	/** Describes the checkout for a workspace; the workspace ID becomes the Capsule ID. */
	readonly resolveSpec: (workspaceID: string) => Effect.Effect<Omit<CapsuleSpec, 'id'>, E, R>
}

const Binding = Schema.Struct({ id: CapsuleId, directory: AbsolutePath })

export const make = Effect.fn('CapsuleWorkspace.make')(function* <E, R>({
	resolveSpec,
}: WorkspaceOptions<E, R>) {
	const capsule = yield* Capsule
	const context = yield* Effect.context<R>()

	const create = Effect.fn('CapsuleWorkspace.create')(
		function* ({ workspaceID }: { readonly workspaceID: string }) {
			const spec = yield* resolveSpec(workspaceID).pipe(Effect.provideContext(context))
			const manifest = yield* capsule.prepare({ ...spec, id: workspaceID })
			return { binding: { id: manifest.spec.id, directory: manifest.spec.directory } }
		},
		Effect.mapError(failure('prepare')),
	)

	const connect = Effect.fn('CapsuleWorkspace.connect')(
		function* (input: { readonly workspaceID: string; readonly binding: WorkspaceDriver.Binding }) {
			const binding = yield* Schema.decodeUnknownEffect(Binding)(input.binding).pipe(
				Effect.mapError(() => WorkspaceDriver.Error.make({ message: 'Invalid Capsule binding.' })),
			)
			const manifest = yield* capsule.inspect(binding.id)
			if (
				binding.id !== input.workspaceID ||
				manifest?.spec.id !== binding.id ||
				manifest.spec.directory !== binding.directory
			) {
				return yield* WorkspaceDriver.Error.make({
					message: 'The Capsule binding does not match its persisted state.',
				})
			}
			const spawner = yield* capsule.connect(binding.id)
			return {
				spawner: ChildProcessSpawner.make((command) => spawner.spawn(inheritEnvironment(command))),
			}
		},
		Effect.mapError(failure('connect')),
	)

	const destroy = Effect.fn('CapsuleWorkspace.destroy')(
		function* ({ workspaceID }: { readonly workspaceID: string }) {
			yield* capsule.purge(workspaceID)
		},
		Effect.mapError(failure('purge')),
	)

	return WorkspaceDriver.make({
		create,
		connect,
		// Commands hold no connection between spawns, and retained project services outlive idleness.
		suspendForIdle: () => Effect.void,
		destroy,
	})
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
const failure = (operation: string) => (error: unknown) => {
	if (error instanceof WorkspaceDriver.Error) return error
	if (error instanceof CapsuleError) {
		return WorkspaceDriver.Error.make({ message: `Capsule ${operation} failed: ${error.message}` })
	}
	const tag =
		Predicate.hasProperty(error, '_tag') && Predicate.isString(error._tag) ? ` (${error._tag})` : ''
	return WorkspaceDriver.Error.make({ message: `Capsule ${operation} failed${tag}.` })
}
