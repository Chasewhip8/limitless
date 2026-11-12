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
import { resolveEnvironment, runProjectCommand } from './environment'
import { makeGit } from './git'
import { acquireLock, type LockMode, withLock } from './lock'
import { makeSandboxSpawner } from './process'
import { CapsuleError, CapsuleSpec, type Manifest, type RuntimeSettings } from './schema'
import { makeState } from './state'

export interface CapsuleOptions {
	readonly root: string
	readonly runtime: RuntimeSettings
}

const equivalentSpec = Schema.toEquivalence(CapsuleSpec)

export const make = Effect.fn('Capsule.make')(function* ({ root, runtime }: CapsuleOptions) {
	const host = yield* ChildProcessSpawner.ChildProcessSpawner
	const state = yield* makeState(root)
	const { fs, path } = state
	const git = yield* makeGit(runtime.basePath)
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
	const makeSpawner = Effect.fn('Capsule.makeSpawner')(function* (
		spec: CapsuleSpec,
		environment: ChildProcess.CommandOptions['env'] = {},
	) {
		const owned = state.paths(spec.id)
		const candidates = [
			'/nix/store',
			'/nix/var/nix/daemon-socket',
			'/nix/var/nix/db',
			'/etc/nix/nix.conf',
			'/etc/resolv.conf',
			'/etc/hosts',
			'/etc/nsswitch.conf',
		]
		const mounts = yield* Effect.forEach(candidates, (source) =>
			Effect.gen(function* () {
				if (!(yield* fs.exists(source))) return []
				return [source]
			}),
		)
		if (spec.dockerSocket) {
			const socket = yield* fs.stat(spec.dockerSocket)
			if (socket.type !== 'Socket') {
				return yield* CapsuleError.make({
					code: 'unsafe_path',
					message: 'Docker requires a Unix socket.',
				})
			}
		}
		const gitDirectories = yield* git.discover(spec.directory)
		for (const directory of gitDirectories) {
			if (
				directory === state.root ||
				directory.startsWith(`${state.root}${path.sep}`) ||
				state.root.startsWith(`${directory}${path.sep}`)
			) {
				return yield* CapsuleError.make({
					code: 'unsafe_path',
					message: 'Git metadata and Capsule state must be separate directories.',
				})
			}
		}
		return yield* makeSandboxSpawner({
			directory: spec.directory,
			home: owned.home,
			temporary: owned.temporary,
			runtime: owned.runtime,
			bwrap: runtime.bwrap,
			shell: runtime.shell,
			env: runtime.env,
			basePath: runtime.basePath,
			environment: {
				...environment,
				NIX_REMOTE: 'daemon',
				NIX_SSL_CERT_FILE: runtime.certificates,
				SSL_CERT_FILE: runtime.certificates,
				GIT_SSL_CAINFO: runtime.certificates,
				...(spec.dockerSocket ? { DOCKER_HOST: `unix://${spec.dockerSocket}` } : {}),
			},
			reserved: {
				CAPSULE_ID: spec.id,
				CAPSULE_STATE_DIR: owned.data,
				COMPOSE_PROJECT_NAME: owned.composeProject,
				...(spec.dockerSocket ? { DOCKER_HOST: `unix://${spec.dockerSocket}` } : {}),
			},
			readOnly: [...mounts.flat(), ...(spec.dockerSocket ? [spec.dockerSocket] : [])],
			readWrite: gitDirectories,
		}).pipe(
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, host),
			Effect.provideService(FileSystem.FileSystem, fs),
			Effect.provideService(Path.Path, path),
		)
	})
	const projectSpawner = Effect.fn('Capsule.projectSpawner')(function* (manifest: Manifest) {
		const base = yield* makeSpawner(manifest.spec)
		const environment = yield* resolveEnvironment(base, runtime, manifest.spec)
		return yield* makeSpawner(manifest.spec, environment)
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
	const prepare = Effect.fn('Capsule.prepare')(function* (input: CapsuleSpec, refresh = false) {
		const spec = yield* normalize(input)
		yield* state.initialize(spec.id)
		return yield* locked(
			spec.id,
			'exclusive',
			Effect.gen(function* () {
				const existing = yield* state.read(spec.id)
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
				const preparing = {
					owner: 'limitless-capsule-v1',
					spec,
					generation: (existing?.generation ?? 0) + 1,
					phase: 'preparing',
				} as const
				yield* state.write(preparing)
				yield* state.ensureDirectories(spec.id)
				const spawner = yield* projectSpawner(preparing)
				yield* runProjectCommand(spawner, spec.directory, spec.project.setup, 'setup')
				const ready = { ...preparing, phase: 'ready' } as const
				yield* state.write(ready)
				return ready
			}),
		)
	})
	const inspect = Effect.fn('Capsule.inspect')(function* (input: string) {
		const id = yield* state.initialize(input)
		return yield* locked(id, 'shared', state.read(id))
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
				const spawner = yield* projectSpawner(manifest)
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
							const refreshed = yield* projectSpawner(current)
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
				const stopping = {
					...manifest,
					phase: 'stopping',
					generation: manifest.generation + 1,
				} as const
				yield* state.write(stopping)
				if (manifest.spec.project.stop) {
					const spawner = yield* projectSpawner(stopping)
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
			const spawner = yield* projectSpawner(purging)
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
	return { prepare, inspect, connect, stop, purge }
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
