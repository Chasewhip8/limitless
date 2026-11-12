import { createHash } from 'node:crypto'
import { Effect, FileSystem, Path, Schema } from 'effect'
import { CapsuleError } from '../schema'
import { HostSettings } from './settings'

const invalid = (message: string) => CapsuleError.make({ code: 'unsafe_path', message })

/**
 * Decodes host settings and creates their directories. Build the host's Capsule from the returned
 * canonical storage roots. The control address is normalized but keeps the declared symlink path:
 * OpenCode Locations normalize paths without resolving filesystem symlinks.
 */
export const resolveSettings = Effect.fn('CapsuleHost.resolveSettings')(function* (input: unknown) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const settings = yield* Schema.decodeUnknownEffect(HostSettings)(input).pipe(
		Effect.mapError(() =>
			CapsuleError.make({ code: 'invalid_input', message: 'Invalid Capsule host settings.' }),
		),
	)
	const canonical = Effect.fn('CapsuleHost.canonicalDirectory')(function* (directory: string) {
		yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
		const resolved = yield* fs.realPath(directory)
		if (resolved === '/' || (yield* fs.stat(resolved)).type !== 'Directory') {
			return yield* invalid('Capsule host paths must be dedicated directories.')
		}
		return resolved
	})
	const root = yield* canonical(settings.root)
	const checkoutRoot = yield* canonical(settings.checkoutRoot)
	const controlDirectory = path.resolve(settings.controlDirectory)
	const controlRoot = yield* canonical(controlDirectory)

	const overlaps = (left: string, right: string) =>
		left === right ||
		left.startsWith(`${right}${path.sep}`) ||
		right.startsWith(`${left}${path.sep}`)
	if (
		overlaps(root, checkoutRoot) ||
		overlaps(controlRoot, root) ||
		overlaps(controlRoot, checkoutRoot)
	) {
		return yield* invalid(
			'The Capsule runtime, checkout, and control directories must be separate directories.',
		)
	}
	return { ...settings, root, checkoutRoot, controlDirectory }
})

/** Pins configured roots so retries cannot silently switch storage. */
export const storageIdOf = ({ root, checkoutRoot }: HostSettings) =>
	createHash('sha256')
		.update(JSON.stringify([root, checkoutRoot]))
		.digest('hex')
		.slice(0, 32)
