import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Path, Schema, type Scope, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { describe, expect, it } from 'vitest'
import { makeGit } from '../git'
import { RuntimeSettings } from '../schema'
import { make } from '../service'

const runtimeConfig = process.env.CAPSULE_TEST_RUNTIME
const hostPath = process.env.PATH ?? ''

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices>) =>
	Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

// A dev shell without flake inputs: Nix evaluates a bare derivation whose builder is the pinned
// runtime shell, so preparing the Capsule never fetches nixpkgs.
const fixtureFlake = (shell: string) => {
	const store = shell.split('/').slice(0, 4).join('/')
	const system = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-linux`
	return `{
  outputs = { self }: {
    devShells.${system}.default = builtins.derivation {
      name = "capsule-git-fixture";
      system = "${system}";
      builder = builtins.appendContext "${shell}" { "${store}" = { path = true; }; };
      outputs = [ "out" ];
    };
  };
}
`
}

const makeFixture = Effect.fn('makeFixture')(function* (files: Readonly<Record<string, string>>) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	yield* fs.makeDirectory('/tmp/opencode', { recursive: true })
	const base = yield* fs.realPath(
		yield* fs.makeTempDirectoryScoped({ directory: '/tmp/opencode', prefix: 'capsule-git-' }),
	)
	const at = (...segments: ReadonlyArray<string>) => path.join(base, ...segments)
	yield* fs.makeDirectory(at('home'))

	const git = Effect.fn('git')(function* (args: ReadonlyArray<string>) {
		const handle = yield* spawner.spawn(
			ChildProcess.make('git', args, {
				env: {
					PATH: hostPath,
					HOME: at('home'),
					GIT_CONFIG_GLOBAL: '/dev/null',
					GIT_CONFIG_NOSYSTEM: '1',
					GIT_AUTHOR_NAME: 'Capsule Test',
					GIT_AUTHOR_EMAIL: 'capsule@example.invalid',
					GIT_COMMITTER_NAME: 'Capsule Test',
					GIT_COMMITTER_EMAIL: 'capsule@example.invalid',
				},
				extendEnv: false,
				stdin: 'ignore',
			}),
		)
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[
				Stream.mkString(Stream.decodeText(handle.stdout)),
				Stream.mkString(Stream.decodeText(handle.stderr)),
				handle.exitCode,
			],
			{ concurrency: 'unbounded' },
		)
		if (exitCode !== 0) return yield* Effect.die(`git ${args.join(' ')} failed: ${stderr}`)
		return stdout.trim()
	}, Effect.scoped)

	const main = at('main')
	const linked = at('linked')
	yield* git(['init', '-q', '-b', 'main', main])
	yield* fs.writeFileString(path.join(main, 'source.txt'), 'source\n')
	for (const [name, content] of Object.entries(files)) {
		yield* fs.writeFileString(path.join(main, name), content)
	}
	yield* git(['-C', main, 'add', '.'])
	yield* git(['-C', main, 'commit', '-q', '-m', 'initial'])
	yield* git(['-C', main, 'worktree', 'add', '-q', '-b', 'feature', linked])
	const common = path.join(main, '.git')
	const gitDirectory = yield* git(['-C', linked, 'rev-parse', '--absolute-git-dir'])
	return { fs, path, at, git, main, linked, common, gitDirectory }
})

describe('Git metadata discovery', () => {
	it('names only metadata outside a gitfile checkout and runs no repository hooks', () =>
		run(
			Effect.gen(function* () {
				const { fs, path, at, git, main, linked, common } = yield* makeFixture({})
				const { discover } = yield* makeGit(hostPath)

				const marker = at('fsmonitor-ran')
				yield* fs.writeFileString(at('fsmonitor'), `#!/bin/sh\n: > '${marker}'\n`)
				yield* fs.chmod(at('fsmonitor'), 0o755)
				yield* git(['-C', main, 'config', 'core.fsmonitor', at('fsmonitor')])

				expect(yield* discover(linked)).toEqual([common])
				expect(yield* discover(main)).toEqual([])
				yield* fs.makeDirectory(at('plain'))
				expect(yield* discover(at('plain'))).toEqual([])

				const separate = at('separate')
				yield* git(['init', '-q', '--separate-git-dir', at('separate.git'), separate])
				expect(yield* discover(separate)).toEqual([at('separate.git')])

				expect(yield* fs.exists(marker)).toBe(false)
				// The same repository configuration runs the trap once a command reads the index.
				yield* git(['-C', linked, 'status', '--porcelain'])
				expect(yield* fs.exists(marker)).toBe(true)

				const enclosing = at('meta')
				yield* git([
					'init',
					'-q',
					'--separate-git-dir',
					enclosing,
					path.join(enclosing, 'checkout'),
				])
				expect(yield* Effect.flip(discover(path.join(enclosing, 'checkout')))).toMatchObject({
					_tag: 'CapsuleError',
					code: 'unsafe_path',
				})

				yield* fs.makeDirectory(at('broken'))
				yield* fs.writeFileString(at('broken', '.git'), `gitdir: ${at('missing')}\n`)
				expect(yield* Effect.flip(discover(at('broken')))).toMatchObject({
					_tag: 'CapsuleError',
					code: 'invalid_input',
				})
			}),
		))
})

describe.skipIf(runtimeConfig === undefined)(
	'Linked worktree Capsules with Bubblewrap (CAPSULE_TEST_RUNTIME)',
	() => {
		it(
			'runs Git in an isolated worktree on shared metadata that purge keeps',
			{ timeout: 120_000 },
			() =>
				run(
					Effect.gen(function* () {
						const fs = yield* FileSystem.FileSystem
						const json = yield* fs.readFileString(runtimeConfig ?? '')
						const runtime = yield* Schema.decodeUnknownEffect(
							Schema.fromJsonString(RuntimeSettings),
						)(json)
						const { at, git, main, linked, common, gitDirectory } = yield* makeFixture({
							'flake.nix': fixtureFlake(runtime.shell),
							'flake.lock': '{"nodes":{"root":{}},"root":"root","version":7}\n',
						})
						const capsule = yield* make({ root: at('state'), runtime })
						const spec = {
							id: 'linked',
							directory: linked,
							project: { setup: ['git', 'status', '--porcelain'] },
						}
						const overlapping = yield* make({ root: `${common}/capsule-state`, runtime })
						expect(yield* Effect.flip(overlapping.prepare(spec))).toMatchObject({
							code: 'unsafe_path',
						})

						expect(yield* capsule.prepare(spec)).toMatchObject({ phase: 'ready' })
						const spawner = yield* capsule.connect(spec.id)
						const script = [
							'set -e',
							'git rev-parse --abbrev-ref HEAD --show-toplevel',
							'git status --porcelain',
							`test ! -e '${main}/source.txt'`,
							'echo work > work.txt',
							'git add work.txt',
							'git -c user.name=Capsule -c user.email=capsule@example.invalid commit -q -m capsule',
							'echo staged > staged.txt',
							'git add staged.txt',
						].join('\n')
						const output = yield* spawner.string(ChildProcess.make('/bin/sh', ['-c', script]))
						expect(output.trim().split('\n')).toEqual(['feature', linked])

						expect(yield* git(['-C', main, 'log', '-1', '--format=%s', 'feature'])).toBe('capsule')
						expect(yield* git(['-C', main, 'log', '-1', '--format=%s', 'HEAD'])).toBe('initial')
						expect(yield* git(['-C', main, 'diff', '--cached', '--name-only'])).toBe('')
						expect(yield* git(['-C', linked, 'diff', '--cached', '--name-only'])).toBe('staged.txt')

						expect(yield* capsule.purge(spec.id)).toMatchObject({ phase: 'purged' })
						for (const directory of [common, gitDirectory, linked]) {
							expect((yield* fs.stat(directory)).type).toBe('Directory')
						}
						expect(yield* git(['-C', main, 'worktree', 'list', '--porcelain'])).toContain(
							`worktree ${linked}\n`,
						)
						expect(yield* git(['-C', linked, 'diff', '--cached', '--name-only'])).toBe('staged.txt')
					}),
				),
		)
	},
)
