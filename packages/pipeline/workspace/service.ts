import { Context, Effect, Layer, Schema } from 'effect'
import { makeArchives } from './archive'
import { githubRepositoryUrl, makeGit } from './git'
import { makeProcesses } from './process'
import { PrepareInput, TaskId, WorkspaceError, WorkspaceStatus } from './schema'
import { type Manifest, transition } from './state'
import { makeStorage } from './storage'

export interface WorkspaceConfig {
	readonly root: string
	/** Override only for isolated fixture remotes; production uses canonical GitHub URLs. */
	readonly repositoryUrl?: (repository: string) => string
}

export const make = Effect.fn('WorkspaceService.make')(function* (config: WorkspaceConfig) {
	const storage = yield* makeStorage(config.root)
	const processes = yield* makeProcesses
	const repositories = makeGit(storage, processes, config.repositoryUrl ?? githubRepositoryUrl)
	const archives = makeArchives(storage, processes)
	const { fs, path, paths, checkPath } = storage

	const locked = Effect.fn('WorkspaceService.locked')(function* <A, E, R>(
		operation: Effect.Effect<A, E, R>,
	) {
		yield* storage.ensureRoot()
		const lockPath = path.join(storage.root, '.workspace.lock')
		yield* checkPath(lockPath, 'File')
		yield* fs.open(lockPath, { flag: 'a', mode: 0o600, noFollow: true })
		return yield* processes.withLock(lockPath, operation)
	}, Effect.scoped)
	const safe = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
		operation.pipe(
			Effect.mapError((error) =>
				error instanceof WorkspaceError
					? error
					: WorkspaceError.make({
							code: 'io_failed',
							message: 'A workspace filesystem operation failed; recoverable files were retained.',
						}),
			),
		)
	const decodeTaskId = (taskId: string) =>
		Schema.decodeUnknownEffect(TaskId)(taskId).pipe(
			Effect.mapError(() =>
				WorkspaceError.make({
					code: 'invalid_input',
					message: 'The task identifier must be a canonical UUID.',
				}),
			),
		)
	const decodeInput = (input: PrepareInput) =>
		Schema.decodeUnknownEffect(PrepareInput)(input).pipe(
			Effect.mapError(() =>
				WorkspaceError.make({ code: 'invalid_input', message: 'The workspace input is invalid.' }),
			),
		)
	const checkInput = Effect.fn('WorkspaceService.checkInput')(function* (
		manifest: Manifest,
		input: PrepareInput,
	) {
		const fields = Object.keys(PrepareInput.fields) as Array<keyof PrepareInput>
		if (!fields.every((key) => manifest.input[key] === input[key]))
			return yield* WorkspaceError.make({
				code: 'input_collision',
				message: 'The task identifier is already bound to a different prepare input.',
			})
	})
	const advance = Effect.fn('WorkspaceService.advance')(function* (
		manifest: Manifest,
		event: Parameters<typeof transition>[1],
	) {
		const status = yield* transition(manifest.status, event)
		return yield* storage.write({ ...manifest, status })
	})
	const read = Effect.fn('WorkspaceService.read')(function* (taskId: string) {
		const manifest = yield* storage.read(taskId)
		const owned = paths(taskId)
		yield* checkPath(owned.checkout, 'Directory')
		yield* checkPath(owned.staging, 'Directory')
		yield* checkPath(owned.archive, 'File')
		yield* checkPath(owned.partialArchive, 'File')
		return manifest
	})
	const requireManifest = Effect.fn('WorkspaceService.requireManifest')(function* (taskId: string) {
		const manifest = yield* read(taskId)
		if (manifest === undefined)
			return yield* WorkspaceError.make({
				code: 'illegal_transition',
				message: 'The workspace has not been prepared.',
			})
		return manifest
	})
	const clone = Effect.fn('WorkspaceService.clone')(function* (manifest: Manifest) {
		if (manifest.status._tag !== 'Preparing' || manifest.status.step !== 'clone') return manifest
		yield* repositories.checkRemoteHead(manifest.input)
		yield* repositories.clone(manifest.input, paths(manifest.input.taskId).staging)
		return yield* advance(manifest, { _tag: 'Cloned' })
	})
	const configure = Effect.fn('WorkspaceService.configure')(function* (manifest: Manifest) {
		if (manifest.status._tag !== 'Preparing' || manifest.status.step !== 'configure')
			return manifest
		yield* repositories.configure(manifest.input, paths(manifest.input.taskId).staging)
		return yield* advance(manifest, { _tag: 'Configured' })
	})
	const publish = Effect.fn('WorkspaceService.publish')(function* (manifest: Manifest) {
		if (manifest.status._tag !== 'Preparing' || manifest.status.step !== 'publish') return manifest
		const owned = paths(manifest.input.taskId)
		yield* repositories.checkRemoteHead(manifest.input)
		if (yield* checkPath(owned.checkout, 'Directory')) {
			if (yield* checkPath(owned.staging, 'Directory'))
				return yield* WorkspaceError.make({
					code: 'ownership_mismatch',
					message: 'Both published and staging checkouts exist; neither was changed.',
				})
			yield* repositories.checkClone(owned.checkout)
		} else {
			yield* repositories.checkClone(owned.staging)
			yield* fs.rename(owned.staging, owned.checkout)
			yield* storage.syncDirectory(owned.task)
		}
		return yield* advance(manifest, { _tag: 'Published' })
	})
	const provision = Effect.fn('WorkspaceService.provision')(function* (manifest: Manifest) {
		const cloned = yield* clone(manifest)
		const configured = yield* configure(cloned)
		return yield* publish(configured)
	})
	const createManifest = Effect.fn('WorkspaceService.createManifest')(function* (
		input: PrepareInput,
	) {
		yield* storage.createTask(input.taskId)
		const absent = yield* storage.status(input.taskId)
		const status = yield* transition(absent, { _tag: 'Prepare' })
		return yield* storage.write({ owner: 'pipeline-workspace-v1', input, status })
	})
	const prepareOperation = Effect.fn('WorkspaceService.prepareOperation')(function* (
		input: PrepareInput,
	) {
		const existing = yield* read(input.taskId)
		if (existing !== undefined) {
			yield* checkInput(existing, input)
			switch (existing.status._tag) {
				case 'Preparing': {
					const prepared = yield* provision(existing)
					return prepared.status
				}
				case 'Ready':
					yield* repositories.checkClone(existing.status.directory)
					return existing.status
				case 'Absent':
				case 'Archiving':
				case 'Archived':
				case 'Releasing':
				case 'Released':
					return yield* WorkspaceError.make({
						code: 'illegal_transition',
						message: 'The workspace cannot be prepared in its retained phase.',
					})
			}
		}
		const manifest = yield* createManifest(input)
		const prepared = yield* provision(manifest)
		return prepared.status
	})
	const prepare = Effect.fn('WorkspaceService.prepare')(function* (raw: PrepareInput) {
		const input = yield* decodeInput(raw)
		const status = yield* locked(prepareOperation(input))
		return yield* Schema.decodeUnknownEffect(WorkspaceStatus)(status)
	}, safe)
	const inspectOperation = Effect.fn('WorkspaceService.inspectOperation')(function* (
		taskId: string,
	) {
		const manifest = yield* read(taskId)
		if (manifest === undefined) return yield* storage.status(taskId)
		return manifest.status
	})
	const inspect = Effect.fn('WorkspaceService.inspect')(function* (rawTaskId: string) {
		const taskId = yield* decodeTaskId(rawTaskId)
		return yield* locked(inspectOperation(taskId))
	}, safe)
	const claimArchival = Effect.fn('WorkspaceService.claimArchival')(function* (
		input: PrepareInput,
	) {
		const existing = yield* read(input.taskId)
		if (existing !== undefined) {
			yield* checkInput(existing, input)
			return existing
		}
		if (yield* checkPath(paths(input.taskId).task, 'Directory'))
			return yield* WorkspaceError.make({
				code: 'ownership_mismatch',
				message: 'A task directory without an ownership manifest cannot be archived.',
			})
		return yield* createManifest(input)
	})
	const archiveOperation = Effect.fn('WorkspaceService.archiveOperation')(function* (
		input: PrepareInput,
	) {
		const manifest = yield* claimArchival(input)
		if (manifest.status._tag === 'Archived') {
			yield* archives.verify(manifest.status.archive)
			return manifest.status
		}
		const beginArchiving = Effect.fn('WorkspaceService.beginArchiving')(function* () {
			if (manifest.status._tag === 'Archiving') return manifest
			return yield* advance(manifest, { _tag: 'Archive' })
		})
		const archiving = yield* beginArchiving()
		const { taskId } = input
		yield* repositories.checkRecoverable(paths(taskId).checkout)
		yield* repositories.checkRecoverable(paths(taskId).staging)
		const archive = yield* archives.create(taskId)
		const archived = yield* advance(archiving, { _tag: 'Archived', archive })
		return archived.status
	})
	/** Operator-only: independently verify all checkout writers have stopped before archiving. The helper lock does not cover OpenCode execution. */
	const archive = Effect.fn('WorkspaceService.archive')(function* (raw: PrepareInput) {
		const input = yield* decodeInput(raw)
		return yield* locked(archiveOperation(input))
	}, safe)
	const releaseOperation = Effect.fn('WorkspaceService.releaseOperation')(function* (
		taskId: string,
	) {
		const manifest = yield* requireManifest(taskId)
		if (manifest.status._tag === 'Released') return manifest.status
		const beginReleasing = Effect.fn('WorkspaceService.beginReleasing')(function* () {
			if (manifest.status._tag === 'Releasing') {
				yield* archives.verify(manifest.status.archive)
				return manifest
			}
			if (manifest.status._tag !== 'Archived')
				return yield* WorkspaceError.make({
					code: 'illegal_transition',
					message: 'Only a verified archived workspace can be released.',
				})
			yield* archives.verify(manifest.status.archive)
			yield* repositories.checkRecoverable(paths(taskId).checkout)
			yield* repositories.checkRecoverable(paths(taskId).staging)
			yield* archives.compare(taskId, manifest.status.archive)
			return yield* advance(manifest, { _tag: 'Release' })
		})
		const owned = paths(taskId)
		const releasing = yield* beginReleasing()
		if (yield* checkPath(owned.checkout, 'Directory'))
			yield* fs.remove(owned.checkout, { recursive: true })
		if (yield* checkPath(owned.staging, 'Directory'))
			yield* fs.remove(owned.staging, { recursive: true })
		yield* storage.syncDirectory(owned.task)
		const released = yield* advance(releasing, { _tag: 'Released' })
		return released.status
	})
	/** Operator-only: independently verify all checkout writers have stopped before release. The coordinator must not automatically call this operation. */
	const release = Effect.fn('WorkspaceService.release')(function* (rawTaskId: string) {
		const taskId = yield* decodeTaskId(rawTaskId)
		return yield* locked(releaseOperation(taskId))
	}, safe)
	return {
		prepare,
		inspect,
		archive,
		release,
	}
})

export class WorkspaceService extends Context.Service<
	WorkspaceService,
	Effect.Success<ReturnType<typeof make>>
>()('pipeline/workspace/WorkspaceService') {}

export const workspaceServiceLayer = (config: WorkspaceConfig) =>
	Layer.effect(WorkspaceService, make(config))
