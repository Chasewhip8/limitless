import { access } from 'node:fs/promises'
import path from 'node:path'
import { Effect } from 'effect'
import { FileAccessError, isMissingPath, toolOperationError } from './errors'

export const exists = Effect.fn(function* exists(filePath: string) {
	return yield* Effect.tryPromise({
		try: () => access(filePath),
		catch: (error) => toolOperationError('exists', 'Could not inspect path', error),
	}).pipe(
		Effect.matchEffect({
			onFailure: (error) =>
				isMissingPath(error)
					? Effect.succeed(false)
					: Effect.fail(new FileAccessError({ filePath, message: error.message })),
			onSuccess: () => Effect.succeed(true),
		}),
	)
})

export const findUp = Effect.fn(function* findUp(names: ReadonlyArray<string>, start: string) {
	let current = path.resolve(start)
	while (true) {
		for (const name of names) {
			const candidate = path.join(current, name)
			if (yield* exists(candidate)) return candidate
		}
		const parent = path.dirname(current)
		if (parent === current) return undefined
		current = parent
	}
})

export const findExecutable = Effect.fn(function* findExecutable(name: string, start: string) {
	const local = yield* findUp([path.join('node_modules', '.bin', name)], start)
	return local ?? name
})
