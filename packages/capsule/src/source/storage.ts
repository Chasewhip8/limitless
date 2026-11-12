import { Effect, FileSystem, Option, Path, Schema } from 'effect'
import { SourceError, SourceStatus } from './schema'
import { Manifest } from './state'

const maximumManifestBytes = 16_384

const invalidManifest = () =>
	SourceError.make({ code: 'invalid_manifest', message: 'The source manifest is invalid.' })

export const makeStorage = Effect.fn('SourceStorage.make')(function* (configuredRoot: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	if (!path.isAbsolute(configuredRoot) || path.resolve(configuredRoot) === '/') {
		return yield* SourceError.make({
			code: 'unsafe_path',
			message: 'The source root must be an absolute dedicated directory.',
		})
	}
	const root = path.resolve(configuredRoot)
	const locks = path.join(root, '.locks')
	const paths = (id: string) => {
		const owned = path.join(root, id)
		return {
			owned,
			checkout: path.join(owned, 'checkout'),
			staging: path.join(owned, 'staging'),
			manifest: path.join(owned, 'manifest.json'),
			// Staged outside the source directory, so an interrupted first manifest write leaves it
			// empty and adoptable rather than an unowned nonempty directory.
			nextManifest: path.join(locks, `${id}.manifest.next`),
			archive: path.join(owned, 'checkout.tar'),
			partialArchive: path.join(owned, 'checkout.tar.partial'),
			lock: path.join(locks, id),
		}
	}

	const stat = (file: string) =>
		fs.lstat(file).pipe(
			Effect.map(Option.some),
			Effect.catchIf(
				(error) => error.reason._tag === 'NotFound',
				() => Effect.succeed(Option.none()),
			),
		)
	const checkPath = Effect.fn('SourceStorage.checkPath')(function* (
		file: string,
		kind: 'Directory' | 'File',
	) {
		const components = path.resolve(file).split(path.sep).filter(Boolean)
		for (let index = 0; index < components.length; index++) {
			const current = path.join(path.sep, ...components.slice(0, index + 1))
			const info = yield* stat(current)
			if (Option.isNone(info)) return false
			const expected = index === components.length - 1 ? kind : 'Directory'
			if (info.value.type !== expected) {
				return yield* SourceError.make({
					code: 'unsafe_path',
					message: 'A source path has an unsafe file type or symlink.',
				})
			}
			if (expected === 'File' && Option.getOrElse(info.value.nlink, () => 1n) !== 1n) {
				return yield* SourceError.make({
					code: 'unsafe_path',
					message: 'A source control file has an unsafe hard link.',
				})
			}
		}
		return true
	})
	const checkOwnership = Effect.fn('SourceStorage.checkOwnership')(function* (directory: string) {
		const info = yield* fs.lstat(directory)
		if (Option.getOrElse(info.uid, () => -1) !== process.getuid?.() || (info.mode & 0o022) !== 0) {
			return yield* SourceError.make({
				code: 'ownership_mismatch',
				message: 'The source control directory must be owned exclusively by this user.',
			})
		}
	})
	const ensureDirectory = Effect.fn('SourceStorage.ensureDirectory')(function* (directory: string) {
		yield* checkPath(directory, 'Directory')
		yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
		yield* checkPath(directory, 'Directory')
		yield* checkOwnership(directory)
	})
	const ensureFile = Effect.fn('SourceStorage.ensureFile')(function* (file: string) {
		yield* checkPath(file, 'File')
		yield* fs.open(file, { flag: 'a', mode: 0o600, noFollow: true })
	}, Effect.scoped)
	/** Creates the root and the lock file of `id`, which lives outside every source directory. */
	const ensureLock = Effect.fn('SourceStorage.ensureLock')(function* (id: string) {
		const { lock } = paths(id)
		yield* ensureDirectory(root)
		yield* ensureDirectory(locks)
		yield* ensureFile(lock)
		return lock
	})
	const syncDirectory = Effect.fn('SourceStorage.syncDirectory')(function* (directory: string) {
		const handle = yield* fs.open(directory, { flag: 'r', noFollow: true })
		yield* handle.sync
	}, Effect.scoped)

	const read = Effect.fn('SourceStorage.read')(function* (id: string) {
		const owned = paths(id)
		if (!(yield* checkPath(owned.owned, 'Directory'))) return undefined
		yield* checkOwnership(owned.owned)
		if (!(yield* checkPath(owned.manifest, 'File'))) return undefined
		const info = yield* fs.stat(owned.manifest)
		if (info.size > BigInt(maximumManifestBytes)) return yield* invalidManifest()
		const text = yield* fs.readFileString(owned.manifest)
		const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(text).pipe(
			Effect.mapError(invalidManifest),
		)
		const { request, status } = manifest
		if (request.id !== id || status.id !== id || status.directory !== owned.checkout) {
			return yield* SourceError.make({
				code: 'ownership_mismatch',
				message: 'The source manifest does not own this path.',
			})
		}
		if ('archive' in status && status.archive.path !== owned.archive) {
			return yield* SourceError.make({
				code: 'ownership_mismatch',
				message: 'The source archive does not belong to this source.',
			})
		}
		return manifest
	})
	const write = Effect.fn('SourceStorage.write')(function* (manifest: Manifest) {
		const owned = paths(manifest.request.id)
		yield* checkPath(owned.owned, 'Directory')
		yield* checkPath(owned.manifest, 'File')
		yield* checkPath(owned.nextManifest, 'File')
		const json = yield* Schema.encodeEffect(Schema.fromJsonString(Manifest))(manifest)
		const bytes = new TextEncoder().encode(json)
		if (bytes.length > maximumManifestBytes) {
			return yield* SourceError.make({
				code: 'invalid_input',
				message: 'The source request exceeds the manifest size limit.',
			})
		}
		const handle = yield* fs.open(owned.nextManifest, { flag: 'w', mode: 0o600, noFollow: true })
		yield* handle.writeAll(bytes)
		yield* handle.sync
		yield* fs.rename(owned.nextManifest, owned.manifest)
		yield* syncDirectory(owned.owned)
		yield* syncDirectory(locks)
		yield* syncDirectory(root)
		return manifest
	}, Effect.scoped)
	const createDirectory = Effect.fn('SourceStorage.createDirectory')(function* (id: string) {
		const owned = paths(id)
		if (yield* checkPath(owned.owned, 'Directory')) {
			const entries = yield* fs.readDirectory(owned.owned)
			if (entries.length !== 0) {
				return yield* SourceError.make({
					code: 'ownership_mismatch',
					message: 'An unowned source directory already contains files.',
				})
			}
		} else {
			yield* fs.makeDirectory(owned.owned, { mode: 0o700 })
			yield* syncDirectory(root)
		}
	})
	const absent = (id: string) =>
		Schema.decodeUnknownEffect(SourceStatus)({ id, directory: paths(id).checkout, _tag: 'Absent' })
	return {
		fs,
		path,
		paths,
		stat,
		checkPath,
		ensureLock,
		read,
		write,
		createDirectory,
		absent,
		syncDirectory,
	}
})
export type Storage = Effect.Success<ReturnType<typeof makeStorage>>
