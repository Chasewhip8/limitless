import { Effect, FileSystem, Path, Schema } from 'effect'
import { CapsuleError, Project } from './schema'

export const readProject = Effect.fn('CapsuleProject.read')(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const file = path.join(directory, 'capsule.json')
	if (!(yield* fs.exists(file))) return {}
	const json = yield* fs.readFileString(file)
	return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Project))(json, {
		onExcessProperty: 'error',
	}).pipe(
		Effect.mapError(() =>
			CapsuleError.make({
				code: 'invalid_input',
				message: 'Invalid repository capsule.json.',
			}),
		),
	)
})
