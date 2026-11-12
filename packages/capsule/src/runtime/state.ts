import { Effect, FileSystem, Option, Path, Schema } from 'effect'
import { Hex } from 'effect/encoding'
import { CapsuleError, CapsuleId, Manifest } from '../schema'

const maximumManifestBytes = 65_536

export const makeState = Effect.fn('CapsuleState.make')(function* (configuredRoot: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	if (!path.isAbsolute(configuredRoot) || path.resolve(configuredRoot) === '/') {
		return yield* CapsuleError.make({
			code: 'unsafe_path',
			message: 'Capsule state requires an absolute dedicated directory.',
		})
	}
	const root = path.resolve(configuredRoot)
	const paths = (id: string) => {
		const directory = path.join(root, id)
		return {
			directory,
			manifest: path.join(directory, 'manifest.json'),
			nextManifest: path.join(root, '.locks', `${id}.manifest.next`),
			home: path.join(directory, 'home'),
			data: path.join(directory, 'home', '.local', 'state', 'capsule'),
			temporary: path.join(directory, 'tmp'),
			runtime: path.join(directory, 'run'),
			lock: path.join(root, '.locks', id),
			composeProject: `capsule-${Hex.encode(id)}`,
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
	const checkPath = Effect.fn('CapsuleState.checkPath')(function* (
		file: string,
		kind: 'Directory' | 'File',
	) {
		const components = path.resolve(file).split(path.sep).filter(Boolean)
		for (let index = 0; index < components.length; index++) {
			const current = path.join(path.sep, ...components.slice(0, index + 1))
			const info = yield* stat(current)
			if (Option.isNone(info)) return false
			const expected = index === components.length - 1 ? kind : 'Directory'
			if (
				info.value.type !== expected ||
				(expected === 'File' && Option.getOrElse(info.value.nlink, () => 1n) !== 1n)
			) {
				return yield* CapsuleError.make({
					code: 'unsafe_path',
					message: 'A Capsule control path contains a symlink or unexpected file type.',
				})
			}
		}
		return true
	})
	const initialize = Effect.fn('CapsuleState.initialize')(function* (input: string) {
		const id = yield* Schema.decodeUnknownEffect(CapsuleId)(input)
		yield* checkPath(root, 'Directory')
		yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 })
		const locks = path.join(root, '.locks')
		yield* checkPath(locks, 'Directory')
		yield* fs.makeDirectory(locks, { mode: 0o700 }).pipe(
			Effect.catchIf(
				(error) => error.reason._tag === 'AlreadyExists',
				() => Effect.void,
			),
		)
		yield* checkPath(paths(id).lock, 'File')
		return id
	})
	const read = Effect.fn('CapsuleState.read')(function* (id: string) {
		const owned = paths(id)
		if (!(yield* checkPath(owned.directory, 'Directory'))) return undefined
		if (!(yield* checkPath(owned.manifest, 'File'))) {
			const entries = yield* fs.readDirectory(owned.directory)
			if (entries.length === 0) return undefined
			return yield* CapsuleError.make({
				code: 'ownership_mismatch',
				message: 'Refusing to adopt a nonempty directory without a Capsule manifest.',
			})
		}
		const info = yield* fs.stat(owned.manifest)
		if (info.size > BigInt(maximumManifestBytes)) {
			return yield* CapsuleError.make({
				code: 'ownership_mismatch',
				message: 'Invalid Capsule manifest.',
			})
		}
		const json = yield* fs.readFileString(owned.manifest)
		const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(json).pipe(
			Effect.mapError(() =>
				CapsuleError.make({ code: 'ownership_mismatch', message: 'Invalid Capsule manifest.' }),
			),
		)
		if (manifest.spec.id !== id) {
			return yield* CapsuleError.make({
				code: 'ownership_mismatch',
				message: 'The Capsule manifest does not own this directory.',
			})
		}
		return manifest
	})
	const write = Effect.fn('CapsuleState.write')(function* (manifest: Manifest) {
		const owned = paths(manifest.spec.id)
		yield* checkPath(owned.directory, 'Directory')
		yield* fs.makeDirectory(owned.directory, { mode: 0o700 }).pipe(
			Effect.catchIf(
				(error) => error.reason._tag === 'AlreadyExists',
				() => Effect.void,
			),
		)
		yield* checkPath(owned.manifest, 'File')
		yield* checkPath(owned.nextManifest, 'File')
		const json = yield* Schema.encodeEffect(Schema.fromJsonString(Manifest))(manifest)
		const bytes = new TextEncoder().encode(json)
		if (bytes.length > maximumManifestBytes) {
			return yield* CapsuleError.make({
				code: 'invalid_input',
				message: 'The Capsule specification exceeds the manifest size limit.',
			})
		}
		const next = yield* fs.open(owned.nextManifest, { flag: 'w', mode: 0o600, noFollow: true })
		yield* next.writeAll(bytes)
		yield* next.sync
		yield* fs.rename(owned.nextManifest, owned.manifest)
		const directory = yield* fs.open(owned.directory, { flag: 'r', noFollow: true })
		yield* directory.sync
		const staging = yield* fs.open(path.dirname(owned.nextManifest), { flag: 'r', noFollow: true })
		yield* staging.sync
		const parent = yield* fs.open(root, { flag: 'r', noFollow: true })
		yield* parent.sync
	}, Effect.scoped)
	const ensureDirectories = Effect.fn('CapsuleState.ensureDirectories')(function* (id: string) {
		const owned = paths(id)
		for (const directory of [owned.home, owned.data, owned.temporary, owned.runtime]) {
			yield* checkPath(directory, 'Directory')
			yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
		}
	})
	return { fs, path, root, paths, checkPath, initialize, read, write, ensureDirectories }
})

export type State = Effect.Success<ReturnType<typeof makeState>>
