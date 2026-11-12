import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { NodeServices } from '@effect/platform-node'
import {
	ConfigProvider,
	Effect,
	FileSystem,
	Option,
	Path,
	Schema,
	type Scope,
	Stream,
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { describe, expect, it } from 'vitest'
import type { NativePorts } from '../src/host'
import { resolveSettings } from '../src/host/roots'
import { make as makeHost } from '../src/host/service'
import { RuntimeSettings } from '../src/schema'
import { make } from '../src/service'
import type { SourceRequest } from '../src/source/schema'
import type { CreatorInput } from './fixtures/capsule-creator'
import { makeHostGit, serveGit } from './fixtures/git-daemon'

const runtimeConfig = process.env.CAPSULE_TEST_RUNTIME
const repository = 'fixture/project'
const id = 'alpha'
// Synthetic values only: tests never read the hosting process environment or user accounts.
const firstToken = 'ghp_syntheticCreateTokenOne'
const secondToken = 'ghp_syntheticCreateTokenTwo'
const invalidToken = 'ghp_syntheticCreateTokenInvalid'
const identity = { name: 'Capsule Agent', email: 'agent@example.invalid' }

// The program deadline interrupts a stuck test and closes its scope, ending its processes and
// removing its files, with time left for finalization before Vitest abandons the promise.
const testTimeout = 120_000
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices>) =>
	Effect.runPromise(
		effect.pipe(
			Effect.timeout('100 seconds'),
			Effect.scoped,
			Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} })),
			Effect.provide(NodeServices.layer),
		),
	)

// A dev shell without flake inputs: Nix evaluates a bare derivation whose builder is the pinned
// runtime shell, so creating the Capsule never fetches nixpkgs. Derivation attributes become
// variables of the project environment.
const fixtureFlake = (shell: string) => {
	const store = shell.split('/').slice(0, 4).join('/')
	const system = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-linux`
	return `{
  outputs = { self }: {
    devShells.${system}.fixture = builtins.derivation {
      name = "capsule-create-fixture";
      system = "${system}";
      builder = builtins.appendContext "${shell}" { "${store}" = { path = true; }; };
      outputs = [ "out" ];
      FIXTURE_SHELL = "initial";
      shellHook = ''
        if [ -n "''\${GH_TOKEN+x}''\${GITHUB_TOKEN+x}''\${GH_ENTERPRISE_TOKEN+x}''\${GITHUB_ENTERPRISE_TOKEN+x}" ] ||
           [ -n "''\${GIT_CONFIG_COUNT+x}''\${GIT_AUTHOR_NAME+x}''\${GIT_AUTHOR_EMAIL+x}''\${GIT_COMMITTER_NAME+x}''\${GIT_COMMITTER_EMAIL+x}" ]; then
          echo 'Capsule injected credentials while resolving the development environment' >&2
          exit 1
        fi
        export GIT_CONFIG_COUNT=1
        export GIT_CONFIG_KEY_0=core.quotePath
        export GIT_CONFIG_VALUE_0=false
      '';
    };
  };
}
`
}

// Records the checked-out commit, the dev shell, and whether credentials reached setup, then
// fails on the fragile branch until the checkout is repaired.
const setupScript = `set -eu
if [ -n "\${GH_TOKEN:-}" ]; then auth=credentialed; else auth=anonymous; fi
echo "setup $(git rev-parse HEAD) $FIXTURE_SHELL $auth" >> "$CAPSULE_STATE_DIR/lifecycle.log"
test ! -e break-setup || test -e repaired
`

const project = {
	devShell: 'fixture',
	setup: ['/bin/sh', 'setup.sh'],
	stop: ['/bin/sh', '-c', 'echo stop >> "$CAPSULE_STATE_DIR/lifecycle.log"'],
}

const agentWork = `set -e
echo committed > committed.txt
git add committed.txt
git commit -q -m 'agent work'
echo staged > staged.txt
git add staged.txt
echo dirty >> README.md
echo untracked > untracked.txt
git rev-parse HEAD`

const credentialFill = `printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill`

const credentialedTeardown = (operation: 'stop' | 'purge') => [
	'/bin/sh',
	'-c',
	`set -eu; test -n "$GH_TOKEN"; ${credentialFill} >/dev/null; echo ${operation} >> credentialed-hooks.log`,
]

const makeFixture = Effect.fn('makeFixture')(function* (
	options: { readonly github?: boolean } = {},
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	yield* fs.makeDirectory('/tmp/opencode', { recursive: true })
	const base = yield* fs.realPath(
		yield* fs.makeTempDirectoryScoped({ directory: '/tmp/opencode', prefix: 'capsule-create-' }),
	)
	const at = (...segments: ReadonlyArray<string>) => path.join(base, ...segments)
	const json = yield* fs.readFileString(runtimeConfig ?? '')
	const runtime = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeSettings))(json)

	yield* fs.makeDirectory(at('home'))
	const { environment, git } = makeHostGit(at('home'))
	const seed = at('seed')
	const remote = at('remote', `${repository}.git`)
	const commit = Effect.fn('commit')(function* (
		files: Readonly<Record<string, string>>,
		message: string,
	) {
		for (const [name, content] of Object.entries(files))
			yield* fs.writeFileString(path.join(seed, name), content)
		yield* git(['-C', seed, 'add', '.'])
		yield* git(['-C', seed, 'commit', '-q', '-m', message])
		return yield* git(['-C', seed, 'rev-parse', 'HEAD'])
	})
	yield* git(['init', '-q', '-b', 'main', seed])
	const initialSha = yield* commit(
		{
			'flake.nix': fixtureFlake(runtime.shell),
			'flake.lock': '{"nodes":{"root":{}},"root":"root","version":7}\n',
			'capsule.json': `${JSON.stringify({
				...project,
				...(options.github
					? { stop: credentialedTeardown('stop'), purge: credentialedTeardown('purge') }
					: {}),
			})}\n`,
			'setup.sh': setupScript,
			'README.md': 'initial\n',
		},
		'initial',
	)
	const mainSha = yield* commit({ 'README.md': 'second\n' }, 'second')
	yield* git(['-C', seed, 'switch', '-q', '-c', 'fragile'])
	const fragileSha = yield* commit({ 'break-setup': '' }, 'fragile setup')
	yield* git(['-C', seed, 'switch', '-q', 'main'])
	yield* git(['init', '-q', '--bare', '-b', 'main', remote])
	yield* git(['-C', seed, 'push', '-q', remote, 'main', 'fragile'])
	const advance = Effect.gen(function* () {
		const advanced = yield* commit({ 'README.md': 'advanced\n' }, 'advanced')
		yield* git(['-C', seed, 'push', '-q', remote, 'main'])
		return advanced
	})

	const daemon = yield* serveGit(at('remote'), environment)
	const root = at('state')
	const checkoutRoot = at('sources')
	const tokenFile = at('secrets', 'token')
	yield* fs.makeDirectory(at('secrets'))
	const capsule = yield* make({
		root,
		checkoutRoot,
		runtime,
		credentials: { identity, ...(options.github ? { github: { tokenFile } } : {}) },
		repositoryUrl: daemon.url,
	})

	const checkout = path.join(checkoutRoot, id, 'checkout')
	const request: SourceRequest = { id, repository, ref: 'main', branch: 'work', commit: mainSha }
	const lifecycle = fs
		.readFileString(path.join(root, id, 'home', '.local', 'state', 'capsule', 'lifecycle.log'))
		.pipe(
			Effect.map((text) => text.trim().split('\n')),
			Effect.orElseSucceed(() => []),
		)
	const inCheckout = (...args: ReadonlyArray<string>) => git(['-C', checkout, ...args])
	const staging = path.join(checkoutRoot, id, 'staging')
	const inStaging = (...args: ReadonlyArray<string>) => git(['-C', staging, ...args])
	return {
		fs,
		path,
		base,
		root,
		checkoutRoot,
		checkout,
		runtime,
		tokenFile,
		daemon,
		capsule,
		request,
		initialSha,
		mainSha,
		fragileSha,
		advance,
		lifecycle,
		inCheckout,
		staging,
		inStaging,
	}
})

const sandboxed = Effect.fn('sandboxed')(function* (
	spawner: ChildProcessSpawner.ChildProcessSpawner['Service'],
	script: string,
) {
	const handle = yield* spawner.spawn(
		ChildProcess.make('/bin/sh', ['-c', script], { stdin: 'ignore' }),
	)
	const [stdout, stderr, exitCode] = yield* Effect.all(
		[
			Stream.mkString(Stream.decodeText(handle.stdout)),
			Stream.mkString(Stream.decodeText(handle.stderr)),
			handle.exitCode,
		],
		{ concurrency: 'unbounded' },
	)
	if (exitCode !== 0) return yield* Effect.die(`Sandboxed script failed (${exitCode}): ${stderr}`)
	return stdout.trim()
}, Effect.scoped)

/** Files below `directory`, other than `except`, whose bytes contain any of `secrets`. */
const filesContaining = Effect.fn('filesContaining')(function* (
	directory: string,
	secrets: ReadonlyArray<string>,
	except: string,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const found: Array<string> = []
	for (const entry of yield* fs.readDirectory(directory, { recursive: true })) {
		const file = path.join(directory, entry)
		if (file === except || (yield* fs.lstat(file)).type !== 'File') continue
		const bytes = Buffer.from(yield* fs.readFile(file))
		if (secrets.some((secret) => bytes.includes(secret))) found.push(entry)
	}
	return found
})

/** Builds the standalone creator into `directory`, to run on the pinned runtime Node. */
const bundleCreator = Effect.fn('bundleCreator')(function* (directory: string) {
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const entry = fileURLToPath(new URL('./fixtures/capsule-creator.ts', import.meta.url))
	const bundle = path.join(directory, 'capsule-creator.mjs')
	const exitCode = yield* spawner.exitCode(
		ChildProcess.make(
			'bun',
			['build', entry, '--target=node', '--format=esm', '--packages=bundle', '--outfile', bundle],
			{ stdin: 'ignore', stdout: 'ignore' },
		),
	)
	if (exitCode !== 0) return yield* Effect.die(`Bundling the creator failed (${exitCode})`)
	return bundle
})

/**
 * Trampolines carry the source lock on descriptor 0 and writers on 3. Compare device and inode to
 * identify the locked file even inside another mount namespace.
 */
const sourceLockHolders = Effect.fn('sourceLockHolders')(function* (lock: string) {
	const fs = yield* FileSystem.FileSystem
	const identity = (info: FileSystem.File.Info) => `${info.dev}:${Option.getOrUndefined(info.ino)}`
	const expected = identity(yield* fs.stat(lock))
	const holders: Array<{
		readonly pid: number
		readonly args: ReadonlyArray<string>
		readonly descriptor: 0 | 3
	}> = []
	for (const pid of yield* fs.readDirectory('/proc')) {
		if (!/^\d+$/.test(pid)) continue
		for (const descriptor of [0, 3] as const) {
			const held = yield* fs.stat(`/proc/${pid}/fd/${descriptor}`).pipe(
				Effect.map(identity),
				Effect.orElseSucceed(() => undefined),
			)
			if (held !== expected) continue
			const cmdline = yield* fs
				.readFileString(`/proc/${pid}/cmdline`)
				.pipe(Effect.orElseSucceed(() => ''))
			holders.push({
				pid: Number(pid),
				args: cmdline.split('\0').filter((arg) => arg !== ''),
				descriptor,
			})
			break
		}
	}
	return holders
})

/** Waits until every holder of the lock on `file` has exited, by briefly taking it exclusively. */
const awaitLockRelease = Effect.fn('awaitLockRelease')(function* (flock: string, file: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const exitCode = yield* spawner.exitCode(
		ChildProcess.make(flock, ['--exclusive', file, 'true'], { stdin: 'ignore' }),
	)
	if (exitCode !== 0) return yield* Effect.die(`Waiting for the lock ${file} failed (${exitCode})`)
})

/** Kills whatever still holds the source lock, so a failed test leaves no writer behind. */
const killSourceLockHolders = (flock: string, lock: string) =>
	Effect.gen(function* () {
		for (const { pid } of yield* sourceLockHolders(lock))
			yield* Effect.try(() => process.kill(pid, 'SIGKILL')).pipe(Effect.ignore)
		yield* awaitLockRelease(flock, lock)
	}).pipe(Effect.interruptible, Effect.timeout('10 seconds'), Effect.ignore)

describe.skipIf(runtimeConfig === undefined)(
	'Managed-source Capsule creation with Bubblewrap (CAPSULE_TEST_RUNTIME)',
	() => {
		it(
			'creates a full-history checkout on an untracked work branch at the expected commit and runs setup in the dev shell',
			{ timeout: testTimeout },
			() =>
				run(
					Effect.gen(function* () {
						const f = yield* makeFixture()

						const created = yield* f.capsule.create(f.request)
						expect(created).toEqual({
							owner: 'limitless-capsule-v2',
							spec: { id, directory: f.checkout, project },
							source: { root: f.checkoutRoot, request: f.request, commit: f.mainSha },
							generation: 1,
							phase: 'ready',
						})
						expect(yield* f.capsule.inspect(id)).toEqual(created)
						expect(yield* f.inCheckout('symbolic-ref', 'HEAD')).toBe('refs/heads/work')
						expect(yield* f.inCheckout('rev-parse', 'HEAD')).toBe(f.mainSha)
						// A work branch other than the ref has no upstream, so a first push must name its destination.
						for (const key of ['branch.work.remote', 'branch.work.merge']) {
							expect(yield* f.inCheckout('config', '--get', '--default', '', key)).toBe('')
						}
						for (const direction of [[], ['--push']]) {
							expect(yield* f.inCheckout('remote', 'get-url', ...direction, 'origin')).toBe(
								f.daemon.url(repository),
							)
						}
						expect(yield* f.inCheckout('rev-parse', '--is-shallow-repository')).toBe('false')
						expect(yield* f.inCheckout('rev-list', '--max-parents=0', 'HEAD')).toBe(f.initialSha)
						expect(yield* f.inCheckout('rev-parse', 'origin/fragile')).toBe(f.fragileSha)
						expect(yield* f.inCheckout('status', '--porcelain')).toBe('')
						expect(yield* f.lifecycle).toEqual([`setup ${f.mainSha} initial anonymous`])

						const spawner = yield* f.capsule.connect(id)
						expect(yield* sandboxed(spawner, 'printf "%s %s" "$FIXTURE_SHELL" "$PWD"')).toBe(
							`initial ${f.checkout}`,
						)
					}),
				),
		)

		it(
			'refuses checkout roots that overlap runtime state before reserving an ID',
			{ timeout: testTimeout },
			() =>
				run(
					Effect.gen(function* () {
						const { path, root, runtime, capsule, request } = yield* makeFixture()
						for (const unsafe of [root, path.join(root, 'sources'), path.dirname(root)]) {
							const overlapping = yield* make({ root, checkoutRoot: unsafe, runtime })
							expect(yield* Effect.flip(overlapping.create(request))).toMatchObject({
								code: 'unsafe_path',
							})
						}
						const unmanaged = yield* make({ root, runtime })
						expect(yield* Effect.flip(unmanaged.create(request))).toMatchObject({
							code: 'invalid_input',
						})
						expect(yield* capsule.inspect(request.id)).toBeUndefined()
					}),
				),
		)

		it(
			'reserves an ID for its first source request and retries only that request after failures before cloning',
			{ timeout: testTimeout },
			() =>
				run(
					Effect.gen(function* () {
						const f = yield* makeFixture()
						const stale: SourceRequest = { ...f.request, id: 'stale', commit: f.initialSha }
						const reservation = {
							owner: 'limitless-capsule-v2',
							spec: {
								id: 'stale',
								directory: f.path.join(f.checkoutRoot, 'stale', 'checkout'),
								project: {},
							},
							source: { root: f.checkoutRoot, request: stale },
							generation: 1,
							phase: 'creating',
						}
						const staleRef = { _tag: 'SourceError', code: 'stale_ref' }
						expect(yield* Effect.flip(f.capsule.create(stale))).toMatchObject(staleRef)
						expect(yield* f.capsule.inspect('stale')).toEqual(reservation)
						expect(yield* f.fs.exists(reservation.spec.directory)).toBe(false)
						expect(yield* Effect.flip(f.capsule.create(stale))).toMatchObject(staleRef)

						const { commit: _, ...unpinned } = stale
						for (const corrected of [{ ...stale, commit: f.mainSha }, unpinned]) {
							expect(yield* Effect.flip(f.capsule.create(corrected))).toMatchObject({
								_tag: 'CapsuleError',
								code: 'ownership_mismatch',
								message: expect.stringMatching(/new ID/),
							})
						}
						expect(yield* f.capsule.inspect('stale')).toEqual(reservation)

						yield* f.daemon.disconnect
						expect(yield* Effect.flip(f.capsule.create(f.request))).toMatchObject({
							_tag: 'SourceError',
							code: 'git_failed',
						})
						expect(yield* f.capsule.inspect(id)).toMatchObject({
							phase: 'creating',
							source: { root: f.checkoutRoot, request: f.request },
						})
						expect(yield* f.fs.exists(f.checkout)).toBe(false)
						yield* f.daemon.reconnect
						expect(yield* f.capsule.create(f.request)).toMatchObject({
							phase: 'ready',
							source: { root: f.checkoutRoot, request: f.request, commit: f.mainSha },
						})
						expect(yield* f.lifecycle).toEqual([`setup ${f.mainSha} initial anonymous`])

						expect(yield* f.capsule.purge('stale')).toMatchObject({
							phase: 'purged',
							source: reservation.source,
						})
						expect(yield* Effect.flip(f.capsule.create(stale))).toMatchObject({
							code: 'not_prepared',
						})
						expect(
							yield* Effect.flip(f.capsule.create({ ...stale, commit: f.mainSha })),
						).toMatchObject({ code: 'ownership_mismatch' })
					}),
				),
		)

		it(
			'retains agent work across repeated, refreshed, and offline creates without resolving the ref again',
			{ timeout: testTimeout },
			() =>
				run(
					Effect.gen(function* () {
						const f = yield* makeFixture()
						const created = yield* f.capsule.create(f.request)
						const contacted = yield* f.daemon.connections
						const spawner = yield* f.capsule.connect(id)
						const head = yield* sandboxed(spawner, agentWork)
						const status = yield* f.inCheckout('status', '--porcelain')
						expect(status.split('\n')).toEqual([
							' M README.md',
							'A  staged.txt',
							'?? untracked.txt',
						])
						yield* f.advance

						expect(yield* f.capsule.create(f.request)).toEqual(created)
						expect(yield* f.lifecycle).toEqual([`setup ${f.mainSha} initial anonymous`])

						yield* f.daemon.disconnect
						const refreshed = yield* f.capsule.create(f.request, { refresh: true })
						expect(refreshed).toEqual({ ...created, generation: 2 })
						expect(yield* f.lifecycle).toEqual([
							`setup ${f.mainSha} initial anonymous`,
							`setup ${head} initial anonymous`,
						])
						expect(yield* f.inCheckout('symbolic-ref', 'HEAD')).toBe('refs/heads/work')
						expect(yield* sandboxed(spawner, 'git rev-parse HEAD')).toBe(head)
						expect(yield* f.inCheckout('rev-parse', 'origin/main')).toBe(f.mainSha)
						expect(yield* f.inCheckout('status', '--porcelain')).toBe(status)
						expect(yield* f.daemon.connections).toBe(contacted)
						expect(
							yield* Effect.flip(f.capsule.create({ ...f.request, id: 'unreachable' })),
						).toMatchObject({ _tag: 'SourceError', code: 'git_failed' })

						const { commit: _, ...unpinned } = f.request
						for (const changed of [
							{ ...f.request, branch: 'other' },
							{ ...f.request, ref: 'fragile', commit: f.fragileSha },
							unpinned,
						]) {
							expect(yield* Effect.flip(f.capsule.create(changed))).toMatchObject({
								code: 'ownership_mismatch',
							})
						}
						expect(yield* f.capsule.inspect(id)).toEqual(refreshed)

						// Refresh reloads the dev shell from the retained checkout, including its edits.
						const flake = f.path.join(f.checkout, 'flake.nix')
						const definition = yield* f.fs.readFileString(flake)
						yield* f.fs.writeFileString(flake, definition.replace('"initial"', '"refreshed"'))
						expect(yield* sandboxed(spawner, 'printf %s "$FIXTURE_SHELL"')).toBe('initial')
						expect(yield* f.capsule.create(f.request, { refresh: true })).toEqual({
							...created,
							generation: 3,
						})
						expect(yield* sandboxed(spawner, 'printf %s "$FIXTURE_SHELL"')).toBe('refreshed')
						expect(yield* f.inCheckout('rev-parse', 'HEAD')).toBe(head)

						const configuration = f.path.join(f.checkout, 'capsule.json')
						yield* f.fs.writeFileString(configuration, JSON.stringify({ setup: ['true'] }))
						expect(
							yield* Effect.flip(f.capsule.create(f.request, { refresh: true })),
						).toMatchObject({ code: 'ownership_mismatch' })
						expect(yield* f.capsule.inspect(id)).toEqual({ ...created, generation: 3 })
					}),
				),
		)

		it(
			'keeps a published source when setup fails and finishes setup on retry without cloning again',
			{ timeout: testTimeout },
			() =>
				run(
					Effect.gen(function* () {
						const f = yield* makeFixture()
						const request: SourceRequest = {
							id,
							repository,
							ref: 'fragile',
							branch: 'fragile-work',
							commit: f.fragileSha,
						}

						expect(yield* Effect.flip(f.capsule.create(request))).toMatchObject({
							_tag: 'CapsuleError',
							code: 'bootstrap_failed',
						})
						expect(yield* f.capsule.inspect(id)).toMatchObject({
							phase: 'preparing',
							source: { root: f.checkoutRoot, request, commit: f.fragileSha },
						})
						expect(yield* Effect.flip(f.capsule.connect(id))).toMatchObject({
							code: 'not_prepared',
						})
						expect(yield* f.inCheckout('rev-parse', 'HEAD')).toBe(f.fragileSha)
						expect(yield* f.inCheckout('symbolic-ref', 'HEAD')).toBe('refs/heads/fragile-work')

						yield* f.fs.writeFileString(f.path.join(f.checkout, 'repaired'), '')
						yield* f.daemon.disconnect
						expect(yield* f.capsule.create(request)).toMatchObject({
							phase: 'ready',
							source: { root: f.checkoutRoot, request, commit: f.fragileSha },
						})
						expect(yield* f.lifecycle).toEqual([
							`setup ${f.fragileSha} initial anonymous`,
							`setup ${f.fragileSha} initial anonymous`,
						])
						expect(yield* f.inCheckout('status', '--porcelain')).toBe('?? repaired')
					}),
				),
		)

		it(
			'stops, resumes through create, and purges the runtime while retaining the source and its provenance',
			{ timeout: testTimeout },
			() =>
				run(
					Effect.gen(function* () {
						const f = yield* makeFixture()
						const created = yield* f.capsule.create(f.request)
						const spawner = yield* f.capsule.connect(id)
						const head = yield* sandboxed(spawner, agentWork)
						const status = yield* f.inCheckout('status', '--porcelain')

						const stopped = yield* f.capsule.stop(id)
						expect(stopped).toMatchObject({ phase: 'stopped', source: created.source })
						expect(yield* Effect.flip(f.capsule.connect(id))).toMatchObject({
							code: 'not_prepared',
						})
						yield* f.daemon.disconnect
						const resumed = yield* f.capsule.create(f.request)
						expect(resumed).toEqual({ ...created, generation: stopped.generation + 1 })
						expect(yield* f.lifecycle).toEqual([
							`setup ${f.mainSha} initial anonymous`,
							'stop',
							`setup ${head} initial anonymous`,
						])
						expect(yield* sandboxed(spawner, 'git rev-parse HEAD')).toBe(head)

						const purged = yield* f.capsule.purge(id)
						expect(purged).toMatchObject({
							owner: 'limitless-capsule-v2',
							spec: created.spec,
							source: created.source,
							phase: 'purged',
						})
						expect(yield* f.capsule.inspect(id)).toEqual(purged)
						for (const directory of ['home', 'tmp', 'run']) {
							expect(yield* f.fs.exists(f.path.join(f.root, id, directory))).toBe(false)
						}
						expect(yield* f.inCheckout('rev-parse', 'HEAD')).toBe(head)
						expect(yield* f.inCheckout('status', '--porcelain')).toBe(status)
						const ledger = yield* f.fs.readFileString(
							f.path.join(f.checkoutRoot, id, 'manifest.json'),
						)
						expect(JSON.parse(ledger)).toMatchObject({
							owner: 'limitless-source-v1',
							request: f.request,
							resolved: { kind: 'branch', commit: f.mainSha },
							status: { _tag: 'Ready', id, directory: f.checkout },
						})

						expect(yield* Effect.flip(f.capsule.create(f.request))).toMatchObject({
							code: 'not_prepared',
						})
						expect(yield* f.capsule.inspect(id)).toEqual(purged)
						expect(yield* f.inCheckout('rev-parse', 'HEAD')).toBe(head)
					}),
				),
		)

		it(
			'keeps environment resolution credential-free and authenticates source, project, and lifecycle commands',
			{ timeout: testTimeout },
			() =>
				run(
					Effect.gen(function* () {
						const f = yield* makeFixture({ github: true })
						expect(yield* Effect.flip(f.capsule.create(f.request))).toMatchObject({
							_tag: 'SourceError',
							code: 'io_failed',
						})
						expect(yield* f.capsule.inspect(id)).toMatchObject({ phase: 'creating' })
						yield* f.fs.writeFileString(f.tokenFile, `${firstToken}\n`)
						yield* f.capsule.create(f.request)
						expect(yield* f.lifecycle).toEqual([`setup ${f.mainSha} initial credentialed`])

						const spawner = yield* f.capsule.connect(id)
						expect(yield* sandboxed(spawner, credentialFill)).toContain(`password=${firstToken}`)
						expect(yield* sandboxed(spawner, 'gh auth token')).toBe(firstToken)
						const helpers = yield* sandboxed(spawner, 'printenv GIT_CONFIG_COUNT')
						expect(helpers).toBe('3')
						expect(yield* sandboxed(spawner, 'git config core.quotePath')).toBe('false')

						yield* f.fs.writeFileString(f.tokenFile, secondToken)
						expect(yield* sandboxed(spawner, credentialFill)).toContain(`password=${secondToken}`)
						yield* f.capsule.create(f.request, { refresh: true })
						expect(yield* f.lifecycle).toEqual([
							`setup ${f.mainSha} initial credentialed`,
							`setup ${f.mainSha} initial credentialed`,
						])
						expect(yield* sandboxed(spawner, 'printenv GIT_CONFIG_COUNT')).toBe(helpers)
						expect(yield* sandboxed(spawner, 'gh auth token')).toBe(secondToken)

						yield* sandboxed(spawner, "git commit -q --allow-empty -m 'agent identity'")
						expect(yield* f.inCheckout('log', '-1', '--format=%an <%ae>|%cn <%ce>')).toBe(
							'Capsule Agent <agent@example.invalid>|Capsule Agent <agent@example.invalid>',
						)

						// Unusable token files fail closed without echoing their contents.
						yield* f.fs.writeFileString(f.tokenFile, `${invalidToken} trailing`)
						const invalid = yield* Effect.flip(
							spawner.exitCode(ChildProcess.make('/bin/sh', ['-c', 'true'])),
						)
						expect(invalid).toMatchObject({ _tag: 'PlatformError' })
						const refused = yield* Effect.flip(f.capsule.create(f.request, { refresh: true }))
						expect(yield* f.capsule.inspect(id)).toMatchObject({ phase: 'ready', generation: 2 })
						yield* f.fs.remove(f.tokenFile)
						const reconnected = yield* f.capsule.connect(id)
						const missing = yield* Effect.flip(
							reconnected.exitCode(ChildProcess.make('/bin/sh', ['-c', 'true'])),
						)
						expect(missing).toMatchObject({ _tag: 'PlatformError' })
						for (const error of [invalid, refused, missing]) {
							expect(inspect(error, { depth: null })).not.toContain(invalidToken)
						}
						yield* f.fs.writeFileString(f.tokenFile, secondToken)
						expect(yield* sandboxed(spawner, 'gh auth token')).toBe(secondToken)

						expect(
							yield* f.fs.readFileString(f.path.join(f.checkout, '.git', 'config')),
						).not.toMatch(/credential|token/i)
						expect(
							yield* filesContaining(f.base, [firstToken, secondToken, invalidToken], f.tokenFile),
						).toEqual([])

						expect(yield* f.capsule.purge(id)).toMatchObject({ phase: 'purged' })
						expect(
							yield* f.fs.readFileString(f.path.join(f.checkout, 'credentialed-hooks.log')),
						).toBe('stop\npurge\n')
						expect(
							yield* filesContaining(f.base, [firstToken, secondToken, invalidToken], f.tokenFile),
						).toEqual([])
					}),
				),
		)
		it(
			'keeps the source lock with a paused sandboxed Git writer after its Capsule creator is killed',
			{ timeout: testTimeout },
			() =>
				run(
					Effect.gen(function* () {
						const f = yield* makeFixture()
						const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
						const creator = yield* bundleCreator(f.base)
						const lock = f.path.join(f.checkoutRoot, '.locks', id)
						const isClone = ({ args }: { readonly args: ReadonlyArray<string> }) =>
							args[0] === 'git' && args.includes('clone') && args.at(-1) === f.staging
						yield* Effect.addFinalizer(() => killSourceLockHolders(f.runtime.flock, lock))

						// The creator resolves the ref over one connection, then blocks in its clone.
						const clone = yield* f.daemon.pause(1)
						const input: typeof CreatorInput.Encoded = {
							root: f.root,
							checkoutRoot: f.checkoutRoot,
							runtime: f.runtime,
							remote: f.daemon.prefix,
							request: f.request,
						}
						const creatorProcess = yield* spawner.spawn(
							ChildProcess.make(f.runtime.node, [creator, JSON.stringify(input)], {
								stdin: 'ignore',
								stdout: 'ignore',
							}),
						)
						yield* Effect.raceFirst(
							clone.waiting,
							creatorProcess.exitCode.pipe(
								Effect.andThen((code) => Effect.die(`The creator exited (${code}) before cloning`)),
							),
						)
						const before = yield* sourceLockHolders(lock)
						expect(before.find(isClone)?.descriptor).toBe(3)
						expect(
							before
								.filter(({ descriptor }) => descriptor === 0)
								.map(({ args }) => args.slice(0, 2)),
						).toContainEqual([f.runtime.node, '-e'])

						yield* Effect.sync(() => process.kill(creatorProcess.pid, 'SIGKILL'))
						yield* Effect.exit(creatorProcess.exitCode)
						const after = yield* sourceLockHolders(lock)
						expect(after.map(({ pid }) => pid)).not.toContain(creatorProcess.pid)
						expect(after.some(isClone)).toBe(true)

						// The creator's runtime lock holder exits on its own once its parent is gone.
						yield* awaitLockRelease(f.runtime.flock, f.path.join(f.root, '.locks', id))
						const busy = { _tag: 'SourceError', code: 'busy' }
						expect(yield* Effect.flip(f.capsule.stop(id))).toMatchObject(busy)
						const marker = f.path.join(f.root, id, 'tmp', 'marker')
						yield* f.fs.writeFileString(marker, 'retained\n')
						expect(yield* Effect.flip(f.capsule.purge(id))).toMatchObject(busy)
						const source = { root: f.checkoutRoot, request: f.request }
						const reserved = yield* f.capsule.inspect(id)
						expect(reserved).toMatchObject({ phase: 'creating' })
						expect(reserved?.source).toEqual(source)
						for (const directory of ['home', 'tmp', 'run']) {
							expect(yield* f.fs.exists(f.path.join(f.root, id, directory))).toBe(true)
						}
						expect(yield* f.fs.readFileString(marker)).toBe('retained\n')
						expect((yield* sourceLockHolders(lock)).some(isClone)).toBe(true)

						yield* clone.resume
						yield* awaitLockRelease(f.runtime.flock, lock)
						const purged = yield* f.capsule.purge(id)
						expect(purged).toMatchObject({ phase: 'purged' })
						expect(purged?.source).toEqual(source)
						expect(yield* sourceLockHolders(lock)).toEqual([])
						for (const directory of ['home', 'tmp', 'run']) {
							expect(yield* f.fs.exists(f.path.join(f.root, id, directory))).toBe(false)
						}
						const ledger = yield* f.fs.readFileString(
							f.path.join(f.checkoutRoot, id, 'manifest.json'),
						)
						expect(JSON.parse(ledger)).toMatchObject({
							request: f.request,
							resolved: { kind: 'branch', commit: f.mainSha },
							status: { _tag: 'Preparing', step: 'clone' },
						})
						expect(yield* f.fs.exists(f.checkout)).toBe(false)
						expect(yield* f.inStaging('rev-parse', 'refs/remotes/origin/main')).toBe(f.mainSha)
						expect(yield* Effect.flip(f.capsule.create(f.request))).toMatchObject({
							code: 'not_prepared',
						})
					}),
				),
		)

		it(
			'refuses to resume a Capsule stopped between host preflight and creation, leaving resumption to its operator',
			{ timeout: testTimeout },
			() =>
				run(
					Effect.gen(function* () {
						const f = yield* makeFixture()
						const raceId = 'wrk_stop_race'
						const request = { ...f.request, id: raceId }
						const { id: _, ...source } = request
						const lifecycle = f.fs
							.readFileString(
								f.path.join(f.root, raceId, 'home', '.local', 'state', 'capsule', 'lifecycle.log'),
							)
							.pipe(Effect.map((text) => text.trim().split('\n')))
						const setups = Effect.map(
							lifecycle,
							(entries) => entries.filter((entry) => entry.startsWith('setup ')).length,
						)
						expect(yield* f.capsule.create(request)).toMatchObject({ phase: 'ready' })

						// The host's preflight sees a ready Capsule; the operator's stop lands while OpenCode
						// commits the workspace, before the host asks the Capsule to create it.
						const operations: Array<string> = []
						const unexpected = (operation: string) => () =>
							Effect.die(`The host must not ${operation} after a refused creation.`)
						const native: NativePorts = {
							workspaces: {
								create: ({ id }) =>
									Effect.gen(function* () {
										operations.push('workspace.create')
										expect(yield* f.capsule.stop(id)).toMatchObject({ phase: 'stopped' })
										return id
									}),
								get: () => Effect.sync(() => undefined),
								provision: unexpected('provision the workspace'),
							},
							sessions: {
								get: () => Effect.sync(() => undefined),
								create: unexpected('create the session'),
							},
						}
						const settings = yield* resolveSettings({
							root: f.root,
							checkoutRoot: f.checkoutRoot,
							controlDirectory: f.path.join(f.base, 'control'),
							runtime: f.runtime,
						})
						const host = yield* makeHost(settings, f.capsule, native)

						const refused = yield* Effect.flip(
							host.prepareSession({
								storageId: host.info.storageId,
								workspaceId: raceId,
								sessionId: 'ses_stop_race',
								owner: { namespace: 'pipeline', id: 'stop-race' },
								source,
								agent: 'build',
							}),
						)
						expect(refused).toMatchObject({ _tag: 'CapsuleHostRejected', code: 'not_ready' })
						expect(operations).toEqual(['workspace.create'])
						expect(yield* f.capsule.inspect(raceId)).toMatchObject({ phase: 'stopped' })
						expect(yield* setups).toBe(1)
						expect((yield* lifecycle).at(-1)).toBe('stop')

						expect(yield* f.capsule.create(request)).toMatchObject({ phase: 'ready' })
						expect(yield* setups).toBe(2)
					}),
				),
		)
	},
)
