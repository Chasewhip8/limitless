import { Option, Schema } from 'effect'
import { AbsolutePath, CapsuleId, type Manifest } from '../schema'

const Binding = Schema.Struct({ id: CapsuleId, directory: AbsolutePath })
export type Binding = typeof Binding.Type

export const bindingOf = (manifest: Manifest): Binding => ({
	id: manifest.spec.id,
	directory: manifest.spec.directory,
})

/** Whether an opaque provider binding names exactly this Capsule's ID and checkout. */
export const matchesBinding = (binding: unknown, manifest: Manifest) =>
	Option.match(Schema.decodeUnknownOption(Binding)(binding), {
		onNone: () => false,
		onSome: ({ id, directory }) => id === manifest.spec.id && directory === manifest.spec.directory,
	})
