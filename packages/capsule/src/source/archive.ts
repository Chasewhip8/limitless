import { Effect, Schema } from 'effect'
import type { Processes } from './process'
import { ArchiveMetadata, SourceError } from './schema'
import type { Storage } from './storage'

export const makeArchives = (storage: Storage, processes: Processes) => {
	const { fs, path, paths, checkPath, syncDirectory } = storage
	const { run } = processes
	const members = Effect.fn('SourceArchive.members')(function* (id: string) {
		const owned = paths(id)
		const entries: Array<string> = []
		if (yield* checkPath(owned.checkout, 'Directory')) entries.push('checkout')
		if (yield* checkPath(owned.staging, 'Directory')) entries.push('staging')
		return entries
	})
	const checkContents = Effect.fn('SourceArchive.checkContents')(function* (
		id: string,
		entries: ReadonlyArray<string>,
	) {
		const pending = entries.map((entry) => path.join(paths(id).owned, entry))
		for (let index = 0; index < pending.length; index++) {
			const file = pending[index]
			if (file === undefined) continue
			const info = yield* fs.lstat(file)
			if (info.type === 'Socket' || info.type === 'Unknown')
				return yield* SourceError.make({
					code: 'archive_failed',
					message: 'The source contains an entry that cannot be retained in a recoverable archive.',
				})
			if (info.type === 'Directory') {
				const children = yield* fs.readDirectory(file)
				for (const child of children) pending.push(path.join(file, child))
			}
		}
	})
	const creationArgs = (id: string, file: string, entries: ReadonlyArray<string>) => [
		'--create',
		'--sort=name',
		'--format=gnu',
		'--file',
		file,
		'--directory',
		paths(id).owned,
		'--files-from',
		'/dev/null',
		'--',
		...entries,
	]
	const describe = Effect.fn('SourceArchive.describe')(function* (file: string) {
		if (!(yield* checkPath(file, 'File'))) {
			return yield* SourceError.make({
				code: 'archive_failed',
				message: 'The retained source archive is missing.',
			})
		}
		const checksum = yield* run('sha256sum', ['--zero', '--', file], 'archive_failed')
		const info = yield* fs.stat(file)
		return yield* Schema.decodeUnknownEffect(ArchiveMetadata)({
			path: file,
			sha256: checksum.slice(0, 64),
			bytes: Number(info.size),
		})
	})
	const compare = Effect.fn('SourceArchive.compare')(function* (
		id: string,
		metadata: ArchiveMetadata,
	) {
		const owned = paths(id)
		yield* checkPath(metadata.path, 'File')
		yield* run(
			'tar',
			['--compare', '--file', metadata.path, '--directory', owned.owned],
			'archive_failed',
		)
		const entries = yield* members(id)
		yield* checkContents(id, entries)
		const digest = yield* run(
			'tar',
			creationArgs(id, '-', entries),
			'archive_failed',
			undefined,
			'sha256',
		)
		if (digest !== metadata.sha256)
			return yield* SourceError.make({
				code: 'archive_changed',
				message: 'The checkout changed after archival; all remaining files were retained.',
			})
	})
	const create = Effect.fn('SourceArchive.create')(function* (id: string) {
		const owned = paths(id)
		yield* checkPath(owned.archive, 'File')
		yield* checkPath(owned.partialArchive, 'File')
		const entries = yield* members(id)
		yield* checkContents(id, entries)
		const handle = yield* fs.open(owned.partialArchive, { flag: 'w', mode: 0o600, noFollow: true })
		yield* run('tar', creationArgs(id, owned.partialArchive, entries), 'archive_failed')
		yield* handle.sync
		const metadata = yield* describe(owned.partialArchive)
		yield* compare(id, metadata)
		yield* fs.rename(owned.partialArchive, owned.archive)
		yield* syncDirectory(owned.owned)
		return { ...metadata, path: owned.archive }
	}, Effect.scoped)
	const verify = Effect.fn('SourceArchive.verify')(function* (metadata: ArchiveMetadata) {
		const observed = yield* describe(metadata.path)
		if (observed.bytes !== metadata.bytes || observed.sha256 !== metadata.sha256) {
			return yield* SourceError.make({
				code: 'archive_changed',
				message: 'The retained source archive does not match its verified metadata.',
			})
		}
	})
	return { create, compare, verify }
}
