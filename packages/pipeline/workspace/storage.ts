import { Effect, FileSystem, Option, Path, Schema } from 'effect'
import { WorkspaceError, WorkspaceStatus } from './schema'
import { Manifest } from './state'

export const makeStorage = Effect.fn('WorkspaceStorage.make')(function* (configuredRoot: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	if (!path.isAbsolute(configuredRoot) || path.resolve(configuredRoot) === '/') {
		return yield* WorkspaceError.make({
			code: 'unsafe_path',
			message: 'The workspace root must be an absolute dedicated directory.',
		})
	}
	const root = path.resolve(configuredRoot)
	const paths = (taskId: string) => {
		const task = path.join(root, taskId)
		return {
			task,
			checkout: path.join(task, 'checkout'),
			staging: path.join(task, 'staging'),
			manifest: path.join(task, 'manifest.json'),
			nextManifest: path.join(task, '.manifest.next'),
			archive: path.join(task, 'checkout.tar'),
			partialArchive: path.join(task, 'checkout.tar.partial'),
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
	const checkPath = Effect.fn('WorkspaceStorage.checkPath')(function* (
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
				return yield* WorkspaceError.make({
					code: 'unsafe_path',
					message: 'A workspace path has an unsafe file type or symlink.',
				})
			}
			if (expected === 'File' && Option.getOrElse(info.value.nlink, () => 1n) !== 1n) {
				return yield* WorkspaceError.make({
					code: 'unsafe_path',
					message: 'A workspace control file has an unsafe hard link.',
				})
			}
		}
		return true
	})
	const checkOwnership = Effect.fn('WorkspaceStorage.checkOwnership')(function* (
		directory: string,
	) {
		const info = yield* fs.lstat(directory)
		if (Option.getOrElse(info.uid, () => -1) !== process.getuid?.() || (info.mode & 0o022) !== 0) {
			return yield* WorkspaceError.make({
				code: 'ownership_mismatch',
				message: 'The workspace control directory must be owned exclusively by the helper user.',
			})
		}
	})
	const ensureRoot = Effect.fn('WorkspaceStorage.ensureRoot')(function* () {
		yield* checkPath(root, 'Directory')
		yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 })
		yield* checkPath(root, 'Directory')
		yield* checkOwnership(root)
	})
	const syncDirectory = Effect.fn('WorkspaceStorage.syncDirectory')(function* (directory: string) {
		const handle = yield* fs.open(directory, { flag: 'r', noFollow: true })
		yield* handle.sync
	}, Effect.scoped)
	const read = Effect.fn('WorkspaceStorage.read')(function* (taskId: string) {
		const owned = paths(taskId)
		if (!(yield* checkPath(owned.task, 'Directory'))) return undefined
		yield* checkOwnership(owned.task)
		if (!(yield* checkPath(owned.manifest, 'File'))) return undefined
		const info = yield* fs.stat(owned.manifest)
		if (Number(info.size) > 16_384) {
			return yield* WorkspaceError.make({
				code: 'invalid_manifest',
				message: 'The workspace manifest is invalid.',
			})
		}
		const text = yield* fs.readFileString(owned.manifest)
		const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(text).pipe(
			Effect.mapError(() =>
				WorkspaceError.make({
					code: 'invalid_manifest',
					message: 'The workspace manifest is invalid.',
				}),
			),
		)
		if (
			manifest.input.taskId !== taskId ||
			manifest.status.taskId !== taskId ||
			manifest.status.directory !== owned.checkout
		) {
			return yield* WorkspaceError.make({
				code: 'ownership_mismatch',
				message: 'The workspace manifest does not own this path.',
			})
		}
		if ('archive' in manifest.status && manifest.status.archive.path !== owned.archive) {
			return yield* WorkspaceError.make({
				code: 'ownership_mismatch',
				message: 'The workspace archive does not belong to this task.',
			})
		}
		return manifest
	})
	const write = Effect.fn('WorkspaceStorage.write')(function* (manifest: Manifest) {
		const owned = paths(manifest.input.taskId)
		yield* checkPath(owned.task, 'Directory')
		yield* checkPath(owned.manifest, 'File')
		yield* checkPath(owned.nextManifest, 'File')
		const decoded = yield* Schema.decodeUnknownEffect(Manifest)(manifest)
		const handle = yield* fs.open(owned.nextManifest, { flag: 'w', mode: 0o600, noFollow: true })
		yield* handle.writeAll(new TextEncoder().encode(JSON.stringify(decoded)))
		yield* handle.sync
		yield* fs.rename(owned.nextManifest, owned.manifest)
		yield* syncDirectory(owned.task)
		return decoded
	}, Effect.scoped)
	const createTask = Effect.fn('WorkspaceStorage.createTask')(function* (taskId: string) {
		const owned = paths(taskId)
		if (yield* checkPath(owned.task, 'Directory')) {
			const entries = yield* fs.readDirectory(owned.task)
			if (entries.length !== 0) {
				return yield* WorkspaceError.make({
					code: 'ownership_mismatch',
					message: 'An unowned task directory already contains files.',
				})
			}
		} else {
			yield* fs.makeDirectory(owned.task, { mode: 0o700 })
			yield* syncDirectory(root)
		}
	})
	const status = (taskId: string) =>
		Schema.decodeUnknownEffect(WorkspaceStatus)({
			taskId,
			directory: paths(taskId).checkout,
			_tag: 'Absent',
		})
	return {
		fs,
		path,
		root,
		paths,
		stat,
		checkPath,
		ensureRoot,
		read,
		write,
		createTask,
		status,
		syncDirectory,
	}
})
export type Storage = Effect.Success<ReturnType<typeof makeStorage>>
