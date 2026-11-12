import { Effect, FileSystem, Path, Schema } from 'effect'
import { ChildProcess } from 'effect/process'
import { type Credentials, withCredentials } from '../credentials'
import type { RuntimeSettings } from '../schema'
import { make, type SourceCommand } from '../source'
import { SourceError } from '../source/schema'
import type { Execution } from './execution'
import { makeSandboxCommand } from './sandbox'
import type { State } from './state'

interface SourceRuntimeOptions {
	readonly root: string
	readonly id: string
	readonly runtime: RuntimeSettings
	readonly state: State
	readonly execution: Execution
	readonly credentials: Credentials
	readonly repositoryUrl?: (repository: string) => string
}

const commandFailure = () =>
	SourceError.make({
		code: 'io_failed',
		message: 'The source command could not enter its authenticated base environment.',
	})

export const makeSourceRuntime = Effect.fn('CapsuleSource.make')(function* ({
	root,
	id,
	runtime,
	state,
	execution,
	credentials,
	repositoryUrl,
}: SourceRuntimeOptions) {
	const { fs, path } = state
	const directory = path.join(root, id)
	const command = Effect.fn('CapsuleSource.command')(function* (input: SourceCommand) {
		const config = yield* execution.configuration({ id, directory, project: {} })
		const sandbox = yield* makeSandboxCommand(config).pipe(
			Effect.provideService(FileSystem.FileSystem, fs),
			Effect.provideService(Path.Path, path),
		)
		const environment: ChildProcess.CommandOptions['env'] = {
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CONFIG_GLOBAL: '/dev/null',
		}
		for (const [name, value] of Object.entries(input.env)) {
			environment[name] = value ?? undefined
		}
		const request = ChildProcess.make(input.executable, input.args, {
			cwd: input.cwd ?? directory,
			env: environment,
			extendEnv: true,
		})
		const authentication = yield* credentials.environment
		const authorized = withCredentials(request, config.environment, authentication)
		const wrapped = yield* sandbox(authorized)
		if (!ChildProcess.isStandardCommand(wrapped)) return yield* commandFailure()
		const args = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(wrapped.args)
		const env: Record<string, SourceCommand['env'][string]> = {}
		for (const [name, value] of Object.entries(wrapped.options.env ?? {})) {
			env[name] = value ?? null
		}
		return {
			executable: wrapped.command,
			args,
			cwd: wrapped.options.cwd,
			env,
		}
	}, Effect.mapError(commandFailure))
	return yield* make({
		root,
		node: runtime.node,
		flock: runtime.flock,
		environment: { PATH: runtime.basePath },
		command,
		...(repositoryUrl ? { repositoryUrl } : {}),
	}).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path))
})
