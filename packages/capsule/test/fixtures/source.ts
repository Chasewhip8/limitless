import { execFile } from 'node:child_process'
import { access, constants, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, ManagedRuntime } from 'effect'
import { onTestFinished } from 'vitest'
import type { SourceRequest } from '../../src/source/schema'
import { make, Source, type SourceOptions } from '../../src/source/service'

export const execute = promisify(execFile)
export const sourceId = 'fixture-source'

export async function executable(name: string) {
	for (const directory of (process.env.PATH ?? '').split(delimiter)) {
		const file = join(directory, name)
		try {
			await access(file, constants.X_OK)
			return file
		} catch {}
	}
	throw new Error(`Missing test executable: ${name}`)
}

export interface FixtureOptions {
	readonly failCommand?: {
		readonly executable: 'git' | 'tar'
		readonly argument: string
		readonly once: boolean
	}
	readonly fileSystem?: (fs: FileSystem.FileSystem) => FileSystem.FileSystem
	readonly command?: SourceOptions['command']
}

/**
 * An isolated upstream repository with a pull request from a fork branch whose base has advanced,
 * plus an annotated tag on the initial commit of the fork.
 */
export async function sourceFixture(options: FixtureOptions = {}) {
	const directory = await mkdtemp('/tmp/opencode/capsule-source-')
	const cleanup: Array<() => Promise<unknown>> = []
	const gitExecutable = await executable('git')
	const home = join(directory, 'home')
	await mkdir(home)
	const environment: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: home,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
		GIT_TERMINAL_PROMPT: '0',
		LC_ALL: 'C',
		GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
		GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
		SOURCE_FIXTURE_BASE: 'present',
	}
	const git = async (cwd: string, ...args: string[]) => {
		const { stdout } = await execute(gitExecutable, ['-c', 'core.hooksPath=/dev/null', ...args], {
			cwd,
			env: environment,
		})
		return stdout.trim()
	}
	const seed = join(directory, 'seed')
	await git(directory, 'init', '--initial-branch=main', seed)
	await git(seed, 'config', 'user.name', 'Fixture')
	await git(seed, 'config', 'user.email', 'fixture@example.invalid')
	await writeFile(join(seed, 'tracked.txt'), 'initial\n')
	await writeFile(join(seed, 'other.txt'), 'other\n')
	await git(seed, 'add', '.')
	await git(seed, 'commit', '-m', 'initial')
	await git(seed, 'tag', '-a', 'v1', '-m', 'release')
	const initialSha = await git(seed, 'rev-parse', 'HEAD')
	const target = join(directory, 'target.git')
	const source = join(directory, 'source.git')
	await git(directory, 'clone', '--bare', seed, target)
	await git(seed, 'switch', '-c', 'feature/fork')
	await writeFile(join(seed, 'feature.txt'), 'fork feature\n')
	await git(seed, 'add', '.')
	await git(seed, 'commit', '-m', 'fork feature')
	const headSha = await git(seed, 'rev-parse', 'HEAD')
	await git(directory, 'clone', '--bare', seed, source)
	await git(seed, 'switch', 'main')
	await writeFile(join(seed, 'target-only.txt'), 'new target base\n')
	await git(seed, 'add', '.')
	await git(seed, 'commit', '-m', 'new target base')
	const baseSha = await git(seed, 'rev-parse', 'HEAD')
	await git(seed, 'push', target, 'main')
	await git(target, 'fetch', source, 'feature/fork')
	await git(target, 'update-ref', 'refs/pull/7/head', headSha)
	if (options.failCommand !== undefined) {
		const fault = options.failCommand
		const bin = join(directory, 'bin')
		await mkdir(bin)
		const actual = await executable(fault.executable)
		const marker = join(directory, 'fault-injected')
		await writeFile(
			join(bin, fault.executable),
			`#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes(${JSON.stringify(fault.argument)}) && (${!fault.once} || !fs.existsSync(${JSON.stringify(marker)}))) {
 fs.writeFileSync(${JSON.stringify(marker)}, 'injected');
 process.exit(1);
}
const child = cp.spawnSync(${JSON.stringify(actual)}, args, {stdio:['inherit','inherit','inherit',3]});
process.exit(child.status ?? 1);
`,
			{ mode: 0o755 },
		)
		environment.PATH = `${bin}${delimiter}${environment.PATH}`
	}
	const root = join(directory, 'sources')
	const upstream = 'upstream/project'
	const fork = 'contributor/project'
	const repositoryUrl = (repository: string) => (repository === upstream ? target : source)
	const request: SourceRequest = {
		id: sourceId,
		repository: fork,
		ref: 'feature/fork',
		branch: 'feature/fork',
		commit: headSha,
		upstream: { repository: upstream, commits: [baseSha] },
		remoteRefs: [
			{ repository: upstream, ref: 'refs/pull/7/head', commit: headSha },
			{ repository: fork, ref: 'refs/heads/feature/fork', commit: headSha },
		],
	}
	const layer = Layer.effect(
		Source,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			return yield* make({
				root,
				repositoryUrl,
				environment,
				...(options.command ? { command: options.command } : {}),
			}).pipe(Effect.provideService(FileSystem.FileSystem, options.fileSystem?.(fs) ?? fs))
		}),
	).pipe(Layer.provide(NodeServices.layer))
	const runtime = ManagedRuntime.make(layer)
	const call = <A, E>(operation: (service: Source['Service']) => Effect.Effect<A, E>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* Source
				return yield* operation(service)
			}),
		)
	const error = (operation: (service: Source['Service']) => Effect.Effect<unknown, unknown>) =>
		call((service) => Effect.flip(operation(service)))
	onTestFinished(async () => {
		try {
			for (const release of [...cleanup].reverse()) await release()
		} finally {
			await runtime.dispose()
			await rm(directory, { recursive: true, force: true })
		}
	})
	return {
		directory,
		root,
		request,
		initialSha,
		headSha,
		baseSha,
		target,
		source,
		git,
		call,
		error,
		checkout: join(root, sourceId, 'checkout'),
		staging: join(root, sourceId, 'staging'),
		manifest: join(root, sourceId, 'manifest.json'),
		idLock: join(root, '.locks', sourceId),
		environment,
		cleanup,
		repositoryUrl,
	}
}
export type SourceFixture = Awaited<ReturnType<typeof sourceFixture>>

/** Bundles `body` as a standalone Node program that can import the source engine as `make`. */
export async function bundleProgram(f: SourceFixture, name: string, body: string) {
	const resolve = createRequire(import.meta.url).resolve
	const entry = join(f.directory, `${name}.mjs`)
	await writeFile(
		entry,
		`
import { Deferred, Effect, FileSystem } from ${JSON.stringify(resolve('effect'))};
import { NodeServices } from ${JSON.stringify(resolve('@effect/platform-node'))};
import { make } from ${JSON.stringify(fileURLToPath(new URL('../../src/source/service.ts', import.meta.url)))};
const options = ${JSON.stringify({ root: f.root, environment: f.environment })};
const urls = ${JSON.stringify({ upstream: f.target, fork: f.source })};
options.repositoryUrl = (repository) => repository === 'upstream/project' ? urls.upstream : urls.fork;
const request = ${JSON.stringify(f.request)};
${body}
`,
	)
	const bundle = join(f.directory, `${name}.bundle.mjs`)
	await execute(
		await executable('bun'),
		['build', entry, '--target=node', '--format=esm', '--packages=bundle', '--outfile', bundle],
		{ cwd: f.directory },
	)
	return bundle
}
