import { Effect, FileSystem, Option, Path, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { AbsolutePath, CapsuleError } from '../schema'

const outputLimit = 65_536

const RepositoryPaths = Schema.Tuple([AbsolutePath, AbsolutePath])

const unsafe = (message: string) => CapsuleError.make({ code: 'unsafe_path', message })

/**
 * Finds the Git metadata directories that a checkout's `.git` file points to, such as a linked
 * worktree's common directory or a separate Git directory, so they can be mounted with the
 * checkout. Checkouts with a `.git` directory or without Git need nothing extra. Discovery runs
 * the Git found on `basePath` with an otherwise empty environment and never reads the index or
 * runs hooks. Alternates and symlinked layouts are unsupported.
 */
export const makeGit = Effect.fn('Capsule.makeGit')(function* (basePath: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

	const isNormalized = (location: string) =>
		path.isAbsolute(location) && path.resolve(location) === location
	const within = (parent: string, child: string) =>
		child === parent || child.startsWith(parent === '/' ? '/' : `${parent}/`)

	const gitEntry = Effect.fn('CapsuleGit.gitEntry')(function* (directory: string) {
		const info = yield* fs.lstat(path.join(directory, '.git')).pipe(
			Effect.map(Option.some),
			Effect.catchIf(
				(error) => error.reason._tag === 'NotFound',
				() => Effect.succeed(Option.none()),
			),
		)
		return Option.map(info, ({ type }) => type)
	})

	const resolveRepository = Effect.fn('CapsuleGit.resolveRepository')(function* (
		directory: string,
	) {
		const handle = yield* spawner.spawn(
			ChildProcess.make(
				'git',
				[
					'-C',
					directory,
					'rev-parse',
					'--absolute-git-dir',
					'--path-format=absolute',
					'--git-common-dir',
				],
				{
					env: {
						PATH: basePath,
						GIT_CONFIG_GLOBAL: '/dev/null',
						GIT_CONFIG_NOSYSTEM: '1',
						GIT_OPTIONAL_LOCKS: '0',
					},
					extendEnv: false,
					stdin: 'ignore',
				},
			),
		)
		const [output, exitCode] = yield* Effect.all(
			[
				handle.stdout.pipe(
					Stream.decodeText(),
					Stream.runFoldEffect(
						() => '',
						(text, chunk) => {
							if (text.length + chunk.length > outputLimit) {
								return CapsuleError.make({
									code: 'invalid_input',
									message: 'Git reported repository paths beyond the size limit.',
								})
							}
							return Effect.succeed(text + chunk)
						},
					),
				),
				handle.exitCode,
				Stream.runDrain(handle.stderr),
			],
			{ concurrency: 'unbounded' },
		)
		if (exitCode !== 0) {
			return yield* CapsuleError.make({
				code: 'invalid_input',
				message: `Git could not resolve the repository that the checkout's .git file names (exit ${exitCode}).`,
			})
		}
		const [gitDirectory, commonDirectory] = yield* Schema.decodeUnknownEffect(RepositoryPaths)(
			output.replace(/\n$/, '').split('\n'),
		).pipe(
			Effect.mapError(() =>
				CapsuleError.make({
					code: 'invalid_input',
					message: 'Git reported repository paths that are not single absolute paths.',
				}),
			),
		)
		return { gitDirectory, commonDirectory }
	}, Effect.scoped)

	const checkMetadata = Effect.fn('CapsuleGit.checkMetadata')(function* (
		directory: string,
		location: string,
	) {
		if (!isNormalized(location)) {
			return yield* unsafe('Git reported a repository path that is not absolute and normalized.')
		}
		if (within(location, directory)) {
			return yield* unsafe(
				'The Git metadata directory must not contain the checkout or be the filesystem root.',
			)
		}
		const info = yield* fs.stat(location)
		if (info.type !== 'Directory') {
			return yield* unsafe('Git reported repository metadata that is not a directory.')
		}
	})

	const discover = Effect.fn('CapsuleGit.discover')(function* (directory: string) {
		if (!isNormalized(directory)) {
			return yield* CapsuleError.make({
				code: 'invalid_input',
				message: 'The checkout path must be absolute and normalized.',
			})
		}
		const entry = yield* gitEntry(directory)
		if (Option.isNone(entry) || entry.value === 'Directory') return []
		if (entry.value !== 'File') {
			return yield* unsafe('The checkout .git entry must be a directory or a regular gitfile.')
		}

		const { gitDirectory, commonDirectory } = yield* resolveRepository(directory)
		const locations = [...new Set([commonDirectory, gitDirectory])]
		yield* Effect.forEach(locations, (location) => checkMetadata(directory, location), {
			discard: true,
		})
		// The checkout is already mounted, and a linked worktree's directory sits in the common one.
		return locations.filter(
			(location) =>
				!within(directory, location) &&
				!locations.some((other) => other !== location && within(other, location)),
		)
	})

	return { discover }
})
