import { Effect, FileSystem, Path } from 'effect'
import { type ChildProcess, ChildProcessSpawner } from 'effect/process'
import type { Credentials } from '../credentials'
import { CapsuleError, type CapsuleSpec, type RuntimeSettings } from '../schema'
import { resolveEnvironment } from './environment'
import { makeGit } from './git-mounts'
import { makeSandboxSpawner } from './sandbox'
import type { State } from './state'

export const makeExecution = Effect.fn('CapsuleExecution.make')(function* (
	runtime: RuntimeSettings,
	state: State,
	credentials: Credentials,
) {
	const host = yield* ChildProcessSpawner.ChildProcessSpawner
	const { fs, path } = state
	const git = yield* makeGit(runtime.basePath)

	const configuration = Effect.fn('CapsuleExecution.configuration')(function* (
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
		return {
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
		}
	})

	const base = Effect.fn('CapsuleExecution.base')(function* (
		spec: CapsuleSpec,
		environment: ChildProcess.CommandOptions['env'] = {},
	) {
		const config = yield* configuration(spec, environment)
		return yield* makeSandboxSpawner(config).pipe(
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, host),
			Effect.provideService(FileSystem.FileSystem, fs),
			Effect.provideService(Path.Path, path),
		)
	})
	const project = Effect.fn('CapsuleExecution.project')(function* (spec: CapsuleSpec) {
		const bootstrap = yield* base(spec)
		const environment = yield* resolveEnvironment(bootstrap, runtime, spec)
		const spawner = yield* base(spec, environment)
		return credentials.decorate(spawner, environment)
	})
	return { configuration, project }
})

export type Execution = Effect.Success<ReturnType<typeof makeExecution>>
