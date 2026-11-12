import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Path, Schema, type Scope } from 'effect'
import { describe, expect, it } from 'vitest'
import { Manifest, RuntimeSettings } from '../src/schema'
import { runBunFixture } from './fixtures/bun'
import { makeHostGit, serveGit } from './fixtures/git-daemon'

const fixture = fileURLToPath(new URL('./fixtures/opencode-host.ts', import.meta.url))
const runtimeConfig = process.env.CAPSULE_TEST_RUNTIME
// Each owner stops before the one enclosing it, so the innermost reports its own failure and its
// scope still has time to stop the host and remove the fixture before Vitest abandons the test.
const testTimeout = 120_000
const fixtureDeadline = 100_000
const hostDeadline = 90_000
const names = ['alpha', 'bravo'] as const
const repository = (name: string) => `fixture/${name}`
// Synthetic: the embedding host holds it, and no workspace may see it.
const hostToken = 'ghp_syntheticEmbeddedHostToken'
const identity = 'Capsule Agent <agent@example.invalid>'

type Placement =
	| { readonly name: string; readonly checkout: string }
	| {
			readonly name: string
			readonly source: {
				readonly repository: string
				readonly ref: string
				readonly branch: string
				readonly commit: string
			}
	  }

const Report = Schema.Struct({
	workspaces: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			directory: Schema.String,
			sessionWorkspaceID: Schema.String,
			binding: Schema.Unknown,
			userShell: Schema.NullOr(Schema.String),
			agentShell: Schema.NullOr(Schema.String),
			pipeline: Schema.String,
		}),
	),
	destroyed: Schema.Unknown,
	unprovisionedID: Schema.String,
	operations: Schema.Array(Schema.String),
	manifests: Schema.Record(Schema.String, Schema.NullOr(Manifest)),
	spawned: Schema.Array(
		Schema.Struct({ capsule: Schema.String, words: Schema.Array(Schema.String) }),
	),
	toolResults: Schema.Array(Schema.String),
})
type Report = typeof Report.Type

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices>) =>
	Effect.runPromise(
		effect.pipe(Effect.timeout(fixtureDeadline), Effect.scoped, Effect.provide(NodeServices.layer)),
	)

const loadRuntime = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const json = yield* fs.readFileString(runtimeConfig ?? '')
	return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeSettings))(json)
})

// A dev shell without flake inputs: Nix evaluates a bare derivation whose builder is the pinned
// runtime shell, and `nix develop` exports its attributes as the project environment.
const fixtureFlake = (shell: string) => {
	const store = shell.split('/').slice(0, 4).join('/')
	const system = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-linux`
	return `{
  outputs = { self }: {
    devShells.${system}.default = builtins.derivation {
      name = "capsule-opencode-fixture";
      system = "${system}";
      builder = builtins.appendContext "${shell}" { "${store}" = { path = true; }; };
      outputs = [ "out" ];
      CAPSULE_FIXTURE = "project";
    };
  };
}
`
}

const makeHost = Effect.fn('makeHost')(function* (runtime: RuntimeSettings | undefined) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path

	yield* fs.makeDirectory('/tmp/opencode', { recursive: true })
	const root = yield* fs.realPath(
		yield* fs.makeTempDirectoryScoped({ directory: '/tmp/opencode', prefix: 'capsule-opencode-' }),
	)
	const at = (...segments: ReadonlyArray<string>) => path.join(root, ...segments)
	const hostOnly = at('outside', 'host-only')
	const secret = randomUUID()
	for (const directory of [at('home'), at('tmp'), at('config'), at('outside')]) {
		yield* fs.makeDirectory(directory)
	}
	yield* fs.writeFileString(hostOnly, secret)

	const writeSource = Effect.fn('writeSource')(function* (directory: string, name: string) {
		yield* fs.makeDirectory(directory, { recursive: true })
		yield* fs.writeFileString(path.join(directory, 'source.txt'), `${name} source\n`)
		yield* fs.symlink(hostOnly, path.join(directory, 'escape'))
		yield* fs.writeFileString(path.join(directory, 'needle.txt'), `GREP_NEEDLE ${name}\n`)
		yield* fs.writeFileString(path.join(directory, `${name}.needle`), '')
		if (runtime) {
			yield* fs.writeFileString(path.join(directory, 'flake.nix'), fixtureFlake(runtime.shell))
			yield* fs.writeFileString(
				path.join(directory, 'flake.lock'),
				'{"nodes":{"root":{}},"root":"root","version":7}\n',
			)
		}
	})

	const embed = Effect.fn('runEmbeddedHost')(function* (
		workspaces: ReadonlyArray<Placement>,
		remotes: Readonly<Record<string, string>> = {},
	) {
		const input = {
			workspaces,
			config: at('config'),
			hostOnly,
			timeout: hostDeadline - 15_000,
			...(runtime
				? {
						runtime: {
							settings: runtime,
							root: at('state'),
							checkoutRoot: at('sources'),
							remotes,
						},
					}
				: {}),
		}
		// OpenCode's published packages need a newer runtime than the repository's Node.
		const stdout = yield* runBunFixture(fixture, input, {
			env: {
				PATH: process.env.PATH ?? '',
				HOME: at('home'),
				XDG_CONFIG_HOME: at('xdg', 'config'),
				XDG_DATA_HOME: at('xdg', 'data'),
				XDG_CACHE_HOME: at('xdg', 'cache'),
				XDG_STATE_HOME: at('xdg', 'state'),
				TMPDIR: at('tmp'),
				GH_TOKEN: hostToken,
			},
			deadline: hostDeadline,
		})
		const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Report))(stdout.trim())

		expect(yield* fs.exists(at('xdg', 'data', 'opencode'))).toBe(true)
		for (const { directory } of report.workspaces) {
			expect(yield* fs.exists(path.join(directory, 'source.txt'))).toBe(true)
		}
		return report
	})

	return { at, secret, writeSource, embed }
})
type Host = Effect.Success<ReturnType<typeof makeHost>>

const borrowCheckouts = (host: Host) =>
	Effect.forEach(names, (name) =>
		Effect.as(host.writeSource(host.at(name), name), { name, checkout: host.at(name) }),
	)

// Commits each checkout as its own repository and serves the bare remotes on loopback, where
// Capsule's sandboxed clone can reach them.
const publishSources = Effect.fn('publishSources')(function* (host: Host) {
	const { environment, git } = makeHostGit(host.at('home'))
	const sources = yield* Effect.forEach(names, (name) =>
		Effect.gen(function* () {
			const seed = host.at('seed', name)
			const remote = host.at('remote', `${repository(name)}.git`)
			yield* host.writeSource(seed, name)
			yield* git(['init', '-q', '-b', 'main', seed])
			yield* git(['-C', seed, 'add', '.'])
			yield* git(['-C', seed, 'commit', '-q', '-m', name])
			yield* git(['init', '-q', '--bare', '-b', 'main', remote])
			yield* git(['-C', seed, 'push', '-q', remote, 'main'])
			const commit = yield* git(['-C', seed, 'rev-parse', 'HEAD'])
			return { name, source: { repository: repository(name), ref: 'main', branch: 'work', commit } }
		}),
	)
	const daemon = yield* serveGit(host.at('remote'), environment)
	const remotes = Object.fromEntries(
		names.map((name) => [repository(name), daemon.url(repository(name))]),
	)
	return { sources, remotes, git }
})

/**
 * Both workspaces ran through one embedded host, each reached only its own Capsule, and
 * `workspace.destroy` purged the second while an unprovisioned workspace needed no Capsule.
 */
const expectWorkspaces = (
	report: Report,
	{
		secret,
		sandboxed,
		preparation,
	}: {
		readonly secret: string
		readonly sandboxed: boolean
		readonly preparation: 'prepare' | 'create'
	},
) => {
	const [alpha, bravo] = report.workspaces
	if (!alpha || !bravo) throw new Error('Expected two workspaces')
	const unprovisioned = report.unprovisionedID
	const visibility = sandboxed ? 'hidden' : 'visible'

	expect(alpha.id).not.toBe(bravo.id)
	for (const [workspace, other] of [
		[alpha, bravo],
		[bravo, alpha],
	] as const) {
		const { id, directory } = workspace
		expect(workspace.sessionWorkspaceID).toBe(id)
		expect(workspace.binding).toEqual({ id, directory })
		expect(workspace.userShell).toBe(id)
		expect(workspace.agentShell).toBe(`project:${id}:${visibility}:anonymous`)
		expect(workspace.pipeline).toBe('project:project')
		const words = report.spawned
			.filter(({ capsule }) => capsule === id)
			.flatMap((spawn) => spawn.words)
		expect(words).toContain(`${directory}/source.txt`)
		expect(words.some((word) => word.includes(other.directory))).toBe(false)
	}
	expect(report.toolResults).toEqual(
		expect.arrayContaining([
			expect.stringContaining('alpha source'),
			expect.stringContaining('bravo source'),
		]),
	)
	const leaked = report.toolResults.filter((result) => result.includes(secret))
	// The stand-in runs on the host, so the escape probe must succeed there to be meaningful.
	expect(leaked).toHaveLength(sandboxed ? 0 : 2)
	expect(report.toolResults.some((result) => result.includes(hostToken))).toBe(false)

	expect([...report.operations].sort()).toEqual(
		[
			...[alpha.id, bravo.id].flatMap((id) => [
				`${preparation}:${id}`,
				`connect:${id}`,
				`connect:${id}`,
			]),
			`purge:${bravo.id}`,
			`purge:${unprovisioned}`,
		].sort(),
	)
	expect(report.destroyed).toEqual({ destroyed: true })
	expect(report.manifests[alpha.id]?.phase).toBe('ready')
	expect(report.manifests[bravo.id]?.phase).toBe('purged')
	expect(report.manifests[unprovisioned]).toBeNull()

	if (sandboxed) {
		for (const { id, name } of report.workspaces) {
			const rg = report.spawned.filter(
				({ capsule, words }) => capsule === id && words[0]?.endsWith('/bin/rg'),
			)
			expect(rg.map(({ words }) => words[0]?.startsWith('/nix/store/'))).toEqual([true, true])
			expect(report.toolResults).toEqual(
				expect.arrayContaining([
					expect.stringContaining(`GREP_NEEDLE ${name}`),
					expect.stringContaining(`${name}.needle`),
				]),
			)
		}
	}
}

const proveBorrowedWorkspaces = (runtime?: RuntimeSettings) =>
	run(
		Effect.gen(function* () {
			const host = yield* makeHost(runtime)
			const report = yield* host.embed(yield* borrowCheckouts(host))
			expectWorkspaces(report, {
				secret: host.secret,
				sandboxed: runtime !== undefined,
				preparation: 'prepare',
			})
			expect(report.workspaces.map(({ directory }) => directory)).toEqual(
				names.map((name) => host.at(name)),
			)
		}),
	)

describe('OpenCode workspaces', () => {
	it(
		'route the embedded SDK through a controlled Capsule service',
		() => proveBorrowedWorkspaces(),
		testTimeout,
	)

	// Set CAPSULE_TEST_RUNTIME to a runtime JSON file to run on the host's Bubblewrap and Nix daemon.
	it.skipIf(!runtimeConfig)(
		'route the embedded SDK through Bubblewrap Capsules',
		() =>
			Effect.runPromise(loadRuntime.pipe(Effect.provide(NodeServices.layer))).then(
				proveBorrowedWorkspaces,
			),
		testTimeout,
	)

	it.skipIf(!runtimeConfig)(
		'clone managed sources for embedded SDK workspaces and retain them after destroy',
		() =>
			run(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const host = yield* makeHost(yield* loadRuntime)
					const { sources, remotes, git } = yield* publishSources(host)
					const report = yield* host.embed(sources, remotes)
					expectWorkspaces(report, { secret: host.secret, sandboxed: true, preparation: 'create' })

					const [alpha, bravo] = report.workspaces
					for (const { id, name, directory } of report.workspaces) {
						const placement = sources.find((published) => published.name === name)
						if (!placement) throw new Error(`Expected a source for ${name}`)
						const { source } = placement
						expect(directory).toBe(host.at('sources', id, 'checkout'))
						expect(report.manifests[id]).toMatchObject({
							owner: 'limitless-capsule-v2',
							spec: { id, directory },
							source: {
								root: host.at('sources'),
								request: { id, ...source },
								commit: source.commit,
							},
						})

						const inCheckout = (...args: ReadonlyArray<string>) => git(['-C', directory, ...args])
						expect(yield* inCheckout('symbolic-ref', 'HEAD')).toBe('refs/heads/work')
						expect(yield* inCheckout('rev-parse', 'HEAD~1')).toBe(source.commit)
						expect(yield* inCheckout('log', '-1', '--format=%s|%an <%ae>|%cn <%ce>')).toBe(
							`agent ${id}|${identity}|${identity}`,
						)
						expect(yield* inCheckout('show', 'HEAD:status.txt')).toBe(
							['?? agent-shell.txt', '?? status.txt', '?? user-shell.txt'].join('\n'),
						)
						expect(yield* inCheckout('status', '--porcelain')).toBe(
							['?? agent-shell.txt', '?? user-shell.txt'].join('\n'),
						)
					}

					// Destroying a workspace purges its private runtime, but its source and provenance
					// outlive it.
					if (!alpha || !bravo) throw new Error('Expected two workspaces')
					expect(yield* fs.exists(host.at('state', alpha.id, 'home'))).toBe(true)
					expect(yield* fs.exists(host.at('state', bravo.id, 'home'))).toBe(false)
					const ledger = yield* fs.readFileString(
						path.join(host.at('sources', bravo.id), 'manifest.json'),
					)
					expect(JSON.parse(ledger)).toMatchObject({
						request: report.manifests[bravo.id]?.source?.request,
						status: { _tag: 'Ready', id: bravo.id, directory: bravo.directory },
					})
				}),
			),
		testTimeout,
	)
})
