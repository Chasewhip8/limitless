import { Context, Effect, Layer, Schema } from 'effect'
import { CapsuleId } from '../identity'
import { makeArchives } from './archive'
import { githubRepositoryUrl, makeGit } from './git'
import { makeProcesses, type SourceExecution } from './process'
import { SourceError, SourceRequest } from './schema'
import { type Manifest, transition } from './state'
import { makeStorage } from './storage'

export interface SourceOptions extends SourceExecution {
	/**
	 * Dedicated directory holding each source at `<root>/<id>/checkout`, its manifest, and archives;
	 * each source's lock lives at `<root>/.locks/<id>`, outside every source directory.
	 */
	readonly root: string
	/** Override only for isolated fixture remotes; production uses canonical GitHub URLs. */
	readonly repositoryUrl?: (repository: string) => string
}

const equivalentRequest = Schema.toEquivalence(SourceRequest)

export const make = Effect.fn('Source.make')(function* (options: SourceOptions) {
	const storage = yield* makeStorage(options.root)
	const processes = makeProcesses(options)
	const repositories = makeGit(storage, processes, options.repositoryUrl ?? githubRepositoryUrl)
	const archives = makeArchives(storage, processes)
	const { fs, paths, checkPath } = storage

	const locked = Effect.fn('Source.locked')(function* <A, E, R>(
		id: string,
		operation: Effect.Effect<A, E, R>,
	) {
		const lock = yield* storage.ensureLock(id)
		return yield* processes.withLock(lock, operation)
	})
	const safe = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
		operation.pipe(
			Effect.mapError((error) =>
				error instanceof SourceError
					? error
					: SourceError.make({
							code: 'io_failed',
							message: 'A source filesystem operation failed; recoverable files were retained.',
						}),
			),
		)
	const decodeId = (id: string) =>
		Schema.decodeUnknownEffect(CapsuleId)(id).pipe(
			Effect.mapError(() =>
				SourceError.make({ code: 'invalid_input', message: 'The source id is invalid.' }),
			),
		)
	const decodeRequest = (request: SourceRequest) =>
		Schema.decodeUnknownEffect(SourceRequest)(request).pipe(
			Effect.mapError(() =>
				SourceError.make({ code: 'invalid_input', message: 'The source request is invalid.' }),
			),
		)
	const checkRequest = Effect.fn('Source.checkRequest')(function* (
		manifest: Manifest,
		request: SourceRequest,
	) {
		if (!equivalentRequest(manifest.request, request))
			return yield* SourceError.make({
				code: 'input_collision',
				message: 'The source id is already bound to a different request.',
			})
	})
	const resolvedOf = Effect.fn('Source.resolvedOf')(function* (manifest: Manifest) {
		if (manifest.resolved === undefined)
			return yield* SourceError.make({
				code: 'invalid_manifest',
				message: 'The source manifest has no resolved commit.',
			})
		return manifest.resolved
	})
	const advance = Effect.fn('Source.advance')(function* (
		manifest: Manifest,
		event: Parameters<typeof transition>[1],
	) {
		const status = yield* transition(manifest.status, event)
		return yield* storage.write({ ...manifest, status })
	})
	const read = Effect.fn('Source.read')(function* (id: string) {
		const manifest = yield* storage.read(id)
		const owned = paths(id)
		yield* checkPath(owned.checkout, 'Directory')
		yield* checkPath(owned.staging, 'Directory')
		yield* checkPath(owned.archive, 'File')
		yield* checkPath(owned.partialArchive, 'File')
		return manifest
	})

	const clone = Effect.fn('Source.clone')(function* (manifest: Manifest) {
		if (manifest.status._tag !== 'Preparing' || manifest.status.step !== 'clone') return manifest
		const resolved = yield* resolvedOf(manifest)
		yield* repositories.checkRemoteRefs(manifest.request.remoteRefs ?? [])
		yield* repositories.clone(manifest.request, resolved, paths(manifest.request.id).staging)
		return yield* advance(manifest, { _tag: 'Cloned' })
	})
	const configure = Effect.fn('Source.configure')(function* (manifest: Manifest) {
		if (manifest.status._tag !== 'Preparing' || manifest.status.step !== 'configure')
			return manifest
		const resolved = yield* resolvedOf(manifest)
		yield* repositories.configure(manifest.request, resolved, paths(manifest.request.id).staging)
		return yield* advance(manifest, { _tag: 'Configured' })
	})
	const publish = Effect.fn('Source.publish')(function* (manifest: Manifest) {
		if (manifest.status._tag !== 'Preparing' || manifest.status.step !== 'publish') return manifest
		const owned = paths(manifest.request.id)
		yield* repositories.checkRemoteRefs(manifest.request.remoteRefs ?? [])
		if (yield* checkPath(owned.checkout, 'Directory')) {
			if (yield* checkPath(owned.staging, 'Directory'))
				return yield* SourceError.make({
					code: 'ownership_mismatch',
					message: 'Both published and staging checkouts exist; neither was changed.',
				})
			yield* repositories.checkClone(owned.checkout)
		} else {
			yield* repositories.checkClone(owned.staging)
			yield* fs.rename(owned.staging, owned.checkout)
			yield* storage.syncDirectory(owned.owned)
		}
		return yield* advance(manifest, { _tag: 'Published' })
	})
	const provision = Effect.fn('Source.provision')(function* (manifest: Manifest) {
		const cloned = yield* clone(manifest)
		const configured = yield* configure(cloned)
		return yield* publish(configured)
	})
	const create = Effect.fn('Source.create')(function* (request: SourceRequest) {
		yield* storage.createDirectory(request.id)
		const resolved = yield* repositories.resolve(request)
		const absent = yield* storage.absent(request.id)
		const status = yield* transition(absent, { _tag: 'Prepare' })
		return yield* storage.write({ owner: 'limitless-source-v1', request, resolved, status })
	})
	const ready = Effect.fn('Source.ready')(function* (manifest: Manifest) {
		const resolved = yield* resolvedOf(manifest)
		yield* repositories.checkClone(manifest.status.directory)
		return {
			id: manifest.request.id,
			directory: manifest.status.directory,
			branch: manifest.request.branch,
			commit: resolved.commit,
		}
	})
	const prepareOperation = Effect.fn('Source.prepareOperation')(function* (request: SourceRequest) {
		const existing = yield* read(request.id)
		if (existing === undefined) {
			const manifest = yield* create(request)
			const prepared = yield* provision(manifest)
			return yield* ready(prepared)
		}
		yield* checkRequest(existing, request)
		switch (existing.status._tag) {
			case 'Ready':
				return yield* ready(existing)
			case 'Preparing': {
				const prepared = yield* provision(existing)
				return yield* ready(prepared)
			}
			case 'Absent':
			case 'Archiving':
			case 'Archived':
			case 'Releasing':
			case 'Released':
				return yield* SourceError.make({
					code: 'illegal_transition',
					message: 'The source cannot be prepared in its retained phase.',
				})
		}
	})
	/**
	 * Creates or resumes the source. A Ready source is returned as retained, including uncommitted
	 * files and new commits; it is never reset, fetched, or moved to another commit.
	 */
	const prepare = Effect.fn('Source.prepare')(function* (input: SourceRequest) {
		const request = yield* decodeRequest(input)
		return yield* locked(request.id, prepareOperation(request))
	}, safe)

	const inspectOperation = Effect.fn('Source.inspectOperation')(function* (id: string) {
		const manifest = yield* read(id)
		if (manifest === undefined) return yield* storage.absent(id)
		return manifest.status
	})
	const inspect = Effect.fn('Source.inspect')(function* (input: string) {
		const id = yield* decodeId(input)
		return yield* locked(id, inspectOperation(id))
	}, safe)

	const claimArchival = Effect.fn('Source.claimArchival')(function* (request: SourceRequest) {
		const existing = yield* read(request.id)
		if (existing !== undefined) {
			yield* checkRequest(existing, request)
			return existing
		}
		if (yield* checkPath(paths(request.id).owned, 'Directory'))
			return yield* SourceError.make({
				code: 'ownership_mismatch',
				message: 'A source directory without an ownership manifest cannot be archived.',
			})
		yield* storage.createDirectory(request.id)
		const absent = yield* storage.absent(request.id)
		const status = yield* transition(absent, { _tag: 'Archive' })
		return yield* storage.write({ owner: 'limitless-source-v1', request, status })
	})
	const archiveOperation = Effect.fn('Source.archiveOperation')(function* (request: SourceRequest) {
		const manifest = yield* claimArchival(request)
		if (manifest.status._tag === 'Archived') {
			yield* archives.verify(manifest.status.archive)
			return manifest.status
		}
		const beginArchiving = Effect.fn('Source.beginArchiving')(function* () {
			if (manifest.status._tag === 'Archiving') return manifest
			return yield* advance(manifest, { _tag: 'Archive' })
		})
		const archiving = yield* beginArchiving()
		const { id } = request
		yield* repositories.checkRecoverable(paths(id).checkout)
		yield* repositories.checkRecoverable(paths(id).staging)
		const archive = yield* archives.create(id)
		const archived = yield* advance(archiving, { _tag: 'Archived', archive })
		return archived.status
	})
	/**
	 * Operator-only: independently verify every checkout writer, including agents and Capsule
	 * commands, has stopped. The source lock covers only this engine's commands.
	 */
	const archive = Effect.fn('Source.archive')(function* (input: SourceRequest) {
		const request = yield* decodeRequest(input)
		return yield* locked(request.id, archiveOperation(request))
	}, safe)

	const releaseOperation = Effect.fn('Source.releaseOperation')(function* (id: string) {
		const manifest = yield* read(id)
		if (manifest === undefined)
			return yield* SourceError.make({
				code: 'illegal_transition',
				message: 'The source has not been prepared.',
			})
		if (manifest.status._tag === 'Released') return manifest.status
		const beginReleasing = Effect.fn('Source.beginReleasing')(function* () {
			if (manifest.status._tag === 'Releasing') {
				yield* archives.verify(manifest.status.archive)
				return manifest
			}
			if (manifest.status._tag !== 'Archived')
				return yield* SourceError.make({
					code: 'illegal_transition',
					message: 'Only a verified archived source can be released.',
				})
			yield* archives.verify(manifest.status.archive)
			yield* repositories.checkRecoverable(paths(id).checkout)
			yield* repositories.checkRecoverable(paths(id).staging)
			yield* archives.compare(id, manifest.status.archive)
			return yield* advance(manifest, { _tag: 'Release' })
		})
		const owned = paths(id)
		const releasing = yield* beginReleasing()
		if (yield* checkPath(owned.checkout, 'Directory'))
			yield* fs.remove(owned.checkout, { recursive: true })
		if (yield* checkPath(owned.staging, 'Directory'))
			yield* fs.remove(owned.staging, { recursive: true })
		yield* storage.syncDirectory(owned.owned)
		const released = yield* advance(releasing, { _tag: 'Released' })
		return released.status
	})
	/**
	 * Operator-only: deletes the checkout after verifying its archive. Independently verify every
	 * checkout writer has stopped; never call this automatically.
	 */
	const release = Effect.fn('Source.release')(function* (input: string) {
		const id = yield* decodeId(input)
		return yield* locked(id, releaseOperation(id))
	}, safe)

	return { prepare, inspect, archive, release }
})

export class Source extends Context.Service<Source, Effect.Success<ReturnType<typeof make>>>()(
	'capsule/source/Source',
) {}

export const layer = (options: SourceOptions) => Layer.effect(Source, make(options))
