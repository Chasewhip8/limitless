import {
	Context,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Path,
	PlatformError,
	Schema,
	Scope,
	Stream,
	SynchronizedRef,
} from 'effect'
import { type ChildProcess, ChildProcessSpawner } from 'effect/process'
import { type CredentialsOptions, makeCredentials } from './credentials'
import { readProject } from './project'
import { runProjectCommand } from './runtime/environment'
import { makeExecution } from './runtime/execution'
import { acquireLock, type LockMode, withLock } from './runtime/lock'
import { makeSourceRuntime } from './runtime/source'
import { makeState } from './runtime/state'
import {
	CapsuleError,
	CapsuleId,
	CapsuleSpec,
	type ManagedSource,
	type Manifest,
	type RuntimeSettings,
} from './schema'
import { make as makeSource } from './source'
import { SourceRequest } from './source/schema'

export interface CapsuleOptions {
	readonly root: string
	readonly runtime: RuntimeSettings
	readonly credentials?: CredentialsOptions
	readonly checkoutRoot?: string
	/** Override only for isolated fixture remotes; production uses canonical GitHub URLs. */
	readonly repositoryUrl?: (repository: string) => string
}

const equivalentSpec = Schema.toEquivalence(CapsuleSpec)
const equivalentSource = Schema.toEquivalence(SourceRequest)

export const make = Effect.fn('Capsule.make')(function* ({
	root,
	runtime,
	credentials: options = {},
	checkoutRoot,
	repositoryUrl,
}: CapsuleOptions) {
	const host = yield* ChildProcessSpawner.ChildProcessSpawner
	const state = yield* makeState(root)
	const { fs, path } = state
	const credentials = yield* makeCredentials(options, runtime.gh)
	const execution = yield* makeExecution(runtime, state, credentials)
	const lockOptions = (id: string, mode: LockMode) => ({
		path: state.paths(id).lock,
		mode,
		flock: runtime.flock,
		shell: runtime.shell,
	})
	const locked = <A, E, R>(id: string, mode: LockMode, operation: Effect.Effect<A, E, R>) =>
		withLock(lockOptions(id, mode), operation).pipe(
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, host),
		)
	const requireManifest = Effect.fn('Capsule.requireManifest')(function* (id: string) {
		const manifest = yield* state.read(id)
		if (!manifest) {
			return yield* CapsuleError.make({
				code: 'not_prepared',
				message: 'The Capsule does not exist.',
			})
		}
		return manifest
	})
	const normalize = Effect.fn('Capsule.normalize')(function* (input: CapsuleSpec) {
		const decoded = yield* Schema.decodeUnknownEffect(CapsuleSpec)(input)
		const directory = yield* fs.realPath(decoded.directory)
		const withinState = directory === state.root || directory.startsWith(`${state.root}${path.sep}`)
		const containsState = state.root.startsWith(`${directory}${path.sep}`)
		if (directory === '/' || withinState || containsState) {
			return yield* CapsuleError.make({
				code: 'unsafe_path',
				message: 'The source checkout and Capsule state must be separate directories.',
			})
		}
		if ((yield* fs.stat(directory)).type !== 'Directory') {
			return yield* CapsuleError.make({
				code: 'unsafe_path',
				message: 'The checkout must be a directory.',
			})
		}
		return { ...decoded, directory }
	})
	const prepareRuntime = Effect.fn('Capsule.prepareRuntime')(function* (
		spec: CapsuleSpec,
		existing?: Manifest,
		source?: ManagedSource,
	) {
		const provenance = source ?? existing?.source
		const preparing = {
			owner: 'limitless-capsule-v2',
			spec,
			...(provenance ? { source: provenance } : {}),
			generation:
				existing?.phase === 'creating' ? existing.generation : (existing?.generation ?? 0) + 1,
			phase: 'preparing',
		} as const
		yield* state.write(preparing)
		yield* state.ensureDirectories(spec.id)
		const spawner = yield* execution.project(spec)
		yield* runProjectCommand(spawner, spec.directory, spec.project.setup, 'setup')
		const ready = { ...preparing, phase: 'ready' } as const
		yield* state.write(ready)
		return ready
	})
	const sourceQuiescence = Effect.fn('Capsule.sourceQuiescence')(function* (manifest: Manifest) {
		if (!manifest.source || !(yield* fs.exists(manifest.source.root))) return
		const source = yield* makeSource({
			root: manifest.source.root,
			node: runtime.node,
			flock: runtime.flock,
			environment: { PATH: runtime.basePath },
		}).pipe(
			Effect.provideService(FileSystem.FileSystem, fs),
			Effect.provideService(Path.Path, path),
		)
		yield* source.inspect(manifest.spec.id)
	})
	const create = Effect.fn('Capsule.create')(function* (
		input: SourceRequest,
		settings: {
			readonly dockerSocket?: string
			readonly refresh?: boolean
			/** Disable for idempotent host preparation that must not resume an operator-stopped Capsule. */
			readonly allowResume?: boolean
		} = {},
	) {
		const request = yield* Schema.decodeUnknownEffect(SourceRequest)(input)
		if (checkoutRoot === undefined || !path.isAbsolute(checkoutRoot)) {
			return yield* CapsuleError.make({
				code: 'invalid_input',
				message: 'Managed sources require an absolute checkout root.',
			})
		}
		const sourceRoot = path.resolve(checkoutRoot)
		if (
			sourceRoot === '/' ||
			sourceRoot === state.root ||
			sourceRoot.startsWith(`${state.root}${path.sep}`) ||
			state.root.startsWith(`${sourceRoot}${path.sep}`)
		) {
			return yield* CapsuleError.make({
				code: 'unsafe_path',
				message: 'Managed checkout and runtime state roots must be separate directories.',
			})
		}
		const directory = path.join(sourceRoot, request.id, 'checkout')
		yield* state.initialize(request.id)
		return yield* locked(
			request.id,
			'exclusive',
			Effect.gen(function* () {
				const existing = yield* state.read(request.id)
				if (
					existing &&
					(!existing.source ||
						existing.source.root !== sourceRoot ||
						!equivalentSource(existing.source.request, request) ||
						existing.spec.directory !== directory ||
						existing.spec.dockerSocket !== settings.dockerSocket)
				) {
					return yield* CapsuleError.make({
						code: 'ownership_mismatch',
						message:
							'This Capsule ID is already reserved for another source or placement; use a new ID.',
					})
				}
				if (existing && ['purging', 'removing', 'purged'].includes(existing.phase)) {
					return yield* CapsuleError.make({
						code: 'not_prepared',
						message: 'A purged Capsule cannot be reused.',
					})
				}
				if (
					settings.allowResume === false &&
					(existing?.phase === 'stopping' || existing?.phase === 'stopped')
				) {
					return yield* CapsuleError.make({
						code: 'not_prepared',
						message: 'The Capsule was stopped; explicit resumption is required.',
					})
				}
				const initial = {
					owner: 'limitless-capsule-v2',
					spec: {
						id: request.id,
						directory,
						project: {},
						...(settings.dockerSocket ? { dockerSocket: settings.dockerSocket } : {}),
					},
					source: { root: sourceRoot, request },
					generation: 1,
					phase: 'creating',
				} as const
				const reserved = existing ?? initial
				if (!existing) yield* state.write(reserved)
				yield* state.ensureDirectories(request.id)
				const sources = yield* makeSourceRuntime({
					root: sourceRoot,
					id: request.id,
					runtime,
					state,
					execution,
					credentials,
					...(repositoryUrl ? { repositoryUrl } : {}),
				})
				const prepared = yield* sources.prepare(request)
				if (prepared.directory !== directory) {
					return yield* CapsuleError.make({
						code: 'ownership_mismatch',
						message: 'The source preparer returned a different checkout.',
					})
				}
				if (existing?.phase === 'ready' && !settings.refresh) return existing
				const project = yield* readProject(directory).pipe(
					Effect.provideService(FileSystem.FileSystem, fs),
					Effect.provideService(Path.Path, path),
				)
				const spec = { ...reserved.spec, project }
				if (existing?.source?.commit !== undefined && !equivalentSpec(existing.spec, spec)) {
					return yield* CapsuleError.make({
						code: 'ownership_mismatch',
						message:
							'The recorded project configuration changed; attach the checkout to a new Capsule ID.',
					})
				}
				return yield* prepareRuntime(spec, reserved, {
					root: sourceRoot,
					request,
					commit: prepared.commit,
				})
			}),
		)
	})
	const prepare = Effect.fn('Capsule.prepare')(function* (input: CapsuleSpec, refresh = false) {
		const spec = yield* normalize(input)
		yield* state.initialize(spec.id)
		return yield* locked(
			spec.id,
			'exclusive',
			Effect.gen(function* () {
				const existing = yield* state.read(spec.id)
				if (existing?.phase === 'creating') {
					return yield* CapsuleError.make({
						code: 'not_prepared',
						message: 'Finish managed source preparation with create.',
					})
				}
				if (existing && !equivalentSpec(existing.spec, spec)) {
					return yield* CapsuleError.make({
						code: 'ownership_mismatch',
						message: 'This Capsule identity already belongs to another specification.',
					})
				}
				if (existing && ['purged', 'purging', 'removing'].includes(existing.phase)) {
					return yield* CapsuleError.make({
						code: 'not_prepared',
						message: 'A purged Capsule cannot be reused.',
					})
				}
				if (existing?.phase === 'ready' && !refresh) return existing
				return yield* prepareRuntime(spec, existing)
			}),
		)
	})
	const inspect = Effect.fn('Capsule.inspect')(function* (input: string) {
		const id = yield* Schema.decodeUnknownEffect(CapsuleId)(input)
		return yield* state.read(id)
	})
	const connect = Effect.fn('Capsule.connect')(function* (input: string) {
		const id = yield* state.initialize(input)
		const { manifest, spawner } = yield* locked(
			id,
			'shared',
			Effect.gen(function* () {
				const manifest = yield* requireManifest(id)
				if (manifest.phase !== 'ready') {
					return yield* CapsuleError.make({
						code: 'not_prepared',
						message: 'Prepare the Capsule before execution.',
					})
				}
				const spawner = yield* execution.project(manifest.spec)
				return { manifest, spawner }
			}),
		)
		const environment = yield* SynchronizedRef.make({ generation: manifest.generation, spawner })
		const spawn = Effect.fn('Capsule.spawn')(function* (command: ChildProcess.Command) {
			const lock = yield* acquireLock(lockOptions(id, 'shared')).pipe(
				Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, host),
				Effect.mapError(platformFailure),
			)
			const current = yield* requireManifest(id).pipe(Effect.mapError(platformFailure))
			if (current.phase !== 'ready') {
				return yield* platformFailure(
					CapsuleError.make({
						code: 'not_prepared',
						message: 'Prepare the Capsule before execution.',
					}),
				)
			}
			const activeSpawner = yield* lock
				.guard(
					SynchronizedRef.modifyEffect(environment, (cached) =>
						Effect.gen(function* () {
							if (cached.generation === current.generation) return [cached.spawner, cached] as const
							const refreshed = yield* execution.project(current.spec)
							return [refreshed, { generation: current.generation, spawner: refreshed }] as const
						}),
					),
				)
				.pipe(Effect.mapError(platformFailure))
			const handle = yield* lock
				.guard(activeSpawner.spawn(command))
				.pipe(Effect.mapError(platformFailure))
			const lost = lock.lost.pipe(Effect.mapError(platformFailure))
			yield* lost.pipe(
				Effect.catch(() => handle.kill().pipe(Effect.ignore)),
				Effect.forkScoped,
			)
			return ChildProcessSpawner.makeHandle({
				...handle,
				exitCode: Effect.raceFirst(handle.exitCode, lost),
				stdout: Stream.interruptWhen(handle.stdout, lost),
				stderr: Stream.interruptWhen(handle.stderr, lost),
				all: Stream.interruptWhen(handle.all, lost),
				getOutputFd: (fd) => Stream.interruptWhen(handle.getOutputFd(fd), lost),
			})
		})
		return ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				const parent = yield* Effect.scope
				const execution = yield* Scope.fork(parent)
				return yield* spawn(command).pipe(
					Scope.provide(execution),
					Effect.onExit((exit) =>
						Exit.isSuccess(exit) ? Effect.void : Scope.close(execution, exit),
					),
				)
			}),
		)
	})
	const stop = Effect.fn('Capsule.stop')(function* (input: string) {
		const id = yield* state.initialize(input)
		return yield* locked(
			id,
			'exclusive',
			Effect.gen(function* () {
				const manifest = yield* requireManifest(id)
				if (manifest.phase === 'stopped' || manifest.phase === 'purged') return manifest
				if (manifest.phase === 'purging' || manifest.phase === 'removing') {
					return yield* CapsuleError.make({
						code: 'not_prepared',
						message: 'Finish purging this Capsule.',
					})
				}
				yield* sourceQuiescence(manifest)
				const stopping = {
					...manifest,
					phase: 'stopping',
					generation: manifest.generation + 1,
				} as const
				yield* state.write(stopping)
				if (manifest.spec.project.stop) {
					const spawner = yield* execution.project(stopping.spec)
					yield* runProjectCommand(
						spawner,
						manifest.spec.directory,
						manifest.spec.project.stop,
						'stop',
					)
				}
				const stopped = { ...stopping, phase: 'stopped' } as const
				yield* state.write(stopped)
				return stopped
			}),
		)
	})
	const finishServices = Effect.fn('Capsule.finishServices')(function* (manifest: Manifest) {
		if (manifest.phase === 'removing') return manifest
		const purging = {
			...manifest,
			phase: 'purging',
			generation: manifest.generation + 1,
		} as const
		yield* state.write(purging)
		if (manifest.spec.project.stop || manifest.spec.project.purge) {
			yield* state.ensureDirectories(manifest.spec.id)
			const spawner = yield* execution.project(purging.spec)
			yield* runProjectCommand(spawner, manifest.spec.directory, manifest.spec.project.stop, 'stop')
			yield* runProjectCommand(
				spawner,
				manifest.spec.directory,
				manifest.spec.project.purge,
				'purge',
			)
		}
		const removing = { ...purging, phase: 'removing' } as const
		yield* state.write(removing)
		return removing
	})
	const purge = Effect.fn('Capsule.purge')(function* (input: string) {
		const id = yield* state.initialize(input)
		return yield* locked(
			id,
			'exclusive',
			Effect.gen(function* () {
				const manifest = yield* state.read(id)
				if (!manifest || manifest.phase === 'purged') return manifest
				yield* sourceQuiescence(manifest)
				const removing = yield* finishServices(manifest)
				const owned = state.paths(id)
				for (const directory of [owned.home, owned.temporary, owned.runtime]) {
					yield* state.checkPath(directory, 'Directory')
					yield* fs.remove(directory, { recursive: true, force: true })
				}
				const purged = { ...removing, phase: 'purged' } as const
				yield* state.write(purged)
				return purged
			}),
		)
	})
	return { create, prepare, inspect, connect, stop, purge }
})

function platformFailure(cause: unknown) {
	if (PlatformError.isPlatformError(cause)) return cause
	return PlatformError.systemError({
		_tag: 'Unknown',
		module: 'Capsule',
		method: 'spawn',
		description: 'Capsule execution was refused or lost its lifecycle lease.',
		cause,
	})
}

export class Capsule extends Context.Service<Capsule, Effect.Success<ReturnType<typeof make>>>()(
	'capsule/Capsule',
) {}

export const layer = (options: CapsuleOptions) => Layer.effect(Capsule, make(options))
