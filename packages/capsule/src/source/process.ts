import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { Context, Effect, Redacted, Stream } from 'effect'
import { acquireLock, runCommand } from './native'
import { SourceError } from './schema'

export interface SourceCommand {
	readonly executable: string
	readonly args: ReadonlyArray<string>
	readonly cwd?: string | undefined
	/** Applied over the execution environment; `null` removes a variable. */
	readonly env: Readonly<Record<string, string | Redacted.Redacted<string> | null>>
}

export interface SourceExecution {
	/**
	 * Environment of the lock and process helpers, and the base of every command's environment;
	 * defaults to the host's.
	 */
	readonly environment?: NodeJS.ProcessEnv
	/** Node.js that starts each command; defaults to `node` on the environment's `PATH`. */
	readonly node?: string
	/** util-linux `flock`; defaults to `flock` on the environment's `PATH`. */
	readonly flock?: string
	/**
	 * Rewrites every Git, tar, and checksum command immediately before it starts, for example to
	 * reread credentials and run it in Bubblewrap; capture any services when constructing it. Pass
	 * secrets only in `env`. The rewritten process and every source writer it starts must keep
	 * inheriting descriptor 3, which holds the source lock; never close it or make it close-on-exec.
	 */
	readonly command?: (command: SourceCommand) => Effect.Effect<SourceCommand, SourceError>
}

type Failure = 'git_failed' | 'archive_failed'

const scrubbed = {
	GIT_TERMINAL_PROMPT: '0',
	GIT_OPTIONAL_LOCKS: '0',
	LC_ALL: 'C',
	GIT_DIR: null,
	GIT_WORK_TREE: null,
	GIT_COMMON_DIR: null,
	GIT_INDEX_FILE: null,
	GIT_OBJECT_DIRECTORY: null,
	GIT_ALTERNATE_OBJECT_DIRECTORIES: null,
	GIT_CONFIG: null,
	GIT_CONFIG_PARAMETERS: null,
	GIT_CONFIG_COUNT: null,
	GIT_NAMESPACE: null,
	GIT_SHALLOW_FILE: null,
	TAR_OPTIONS: null,
}

const environmentOf = (base: NodeJS.ProcessEnv, overrides: SourceCommand['env']) => {
	const environment: Record<string, string> = {}
	for (const [name, value] of Object.entries(base))
		if (value !== undefined) environment[name] = value
	for (const [name, value] of Object.entries(overrides)) {
		if (value === null) delete environment[name]
		else environment[name] = Redacted.isRedacted(value) ? Redacted.value(value) : value
	}
	return environment
}

class SourceLock extends Context.Service<SourceLock, FileHandle>()('capsule/source/SourceLock') {}

export const makeProcesses = (execution: SourceExecution) => {
	const base = execution.environment ?? process.env
	const helperEnvironment = () => environmentOf(base, {})
	const node = execution.node ?? 'node'
	const flock = execution.flock ?? 'flock'
	const prepare = execution.command ?? ((command: SourceCommand) => Effect.succeed(command))

	const run = Effect.fn('SourceProcess.run')(function* (
		executable: string,
		args: ReadonlyArray<string>,
		code: Failure,
		cwd?: string,
		mode: 'text' | 'sha256' = 'text',
	) {
		const lock = yield* SourceLock
		const command = yield* prepare({ executable, args, cwd, env: scrubbed })
		const result = yield* runCommand(
			node,
			helperEnvironment(),
			lock,
			{ ...command, env: environmentOf(base, command.env) },
			(output) => {
				if (mode === 'sha256')
					return Stream.runFold(
						output,
						() => createHash('sha256'),
						(digest, bytes) => digest.update(bytes),
					).pipe(Effect.map((digest) => digest.digest('hex')))
				return Stream.mkString(Stream.decodeText(output)).pipe(Effect.map((text) => text.trim()))
			},
		)
		if (result.code !== 0)
			return yield* SourceError.make({
				code,
				message: 'A source command failed; recoverable files were retained.',
			})
		return result.text
	})
	const git = (args: ReadonlyArray<string>, cwd?: string) =>
		run(
			'git',
			[
				'-c',
				'core.hooksPath=/dev/null',
				'-c',
				'core.fsmonitor=false',
				'-c',
				'core.untrackedCache=false',
				'-c',
				'gc.auto=0',
				'-c',
				'maintenance.auto=false',
				...args,
			],
			'git_failed',
			cwd,
		)
	/**
	 * Runs `operation` while this process holds the exclusive lock on `file`; its commands inherit it
	 * as descriptor 3.
	 */
	const withLock = Effect.fn('SourceProcess.withLock')(function* <A, E, R>(
		file: string,
		operation: Effect.Effect<A, E, R>,
	) {
		const lock = yield* acquireLock(file, flock, helperEnvironment())
		return yield* operation.pipe(Effect.provideService(SourceLock, lock))
	}, Effect.scoped)
	return { run, git, withLock }
}
export type Processes = ReturnType<typeof makeProcesses>
