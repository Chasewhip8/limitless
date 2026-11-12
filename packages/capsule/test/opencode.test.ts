import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Path, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { describe, expect, it } from 'vitest'
import { RuntimeSettings } from '../schema'

const fixture = fileURLToPath(new URL('./fixtures/opencode-host.ts', import.meta.url))

const Report = Schema.Struct({
	workspaces: Schema.Array(
		Schema.Struct({
			id: Schema.String,
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
	phases: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
	spawned: Schema.Array(
		Schema.Struct({ capsule: Schema.String, words: Schema.Array(Schema.String) }),
	),
	toolResults: Schema.Array(Schema.String),
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

const runEmbeddedHost = Effect.fn('runEmbeddedHost')(function* (
	runtime: RuntimeSettings | undefined,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

	yield* fs.makeDirectory('/tmp/opencode', { recursive: true })
	const root = yield* fs.realPath(
		yield* fs.makeTempDirectoryScoped({ directory: '/tmp/opencode', prefix: 'capsule-opencode-' }),
	)
	const at = (...segments: ReadonlyArray<string>) => path.join(root, ...segments)
	const checkouts = [at('alpha'), at('bravo')]
	const hostOnly = at('outside', 'host-only')
	const secret = randomUUID()
	for (const directory of [at('home'), at('tmp'), at('config'), at('outside'), ...checkouts]) {
		yield* fs.makeDirectory(directory)
	}
	yield* fs.writeFileString(hostOnly, secret)
	for (const directory of checkouts) {
		yield* fs.writeFileString(
			path.join(directory, 'source.txt'),
			`${path.basename(directory)} source\n`,
		)
		yield* fs.symlink(hostOnly, path.join(directory, 'escape'))
		yield* fs.writeFileString(
			path.join(directory, 'needle.txt'),
			`GREP_NEEDLE ${path.basename(directory)}\n`,
		)
		yield* fs.writeFileString(path.join(directory, `${path.basename(directory)}.needle`), '')
		if (runtime) {
			yield* fs.writeFileString(path.join(directory, 'flake.nix'), fixtureFlake(runtime.shell))
			yield* fs.writeFileString(
				path.join(directory, 'flake.lock'),
				'{"nodes":{"root":{}},"root":"root","version":7}\n',
			)
		}
	}

	const input = {
		checkouts,
		config: at('config'),
		hostOnly,
		search: runtime !== undefined,
		...(runtime ? { runtime: { settings: runtime, root: at('state') } } : {}),
	}
	const handle = yield* spawner.spawn(
		// OpenCode's published packages need a newer runtime than the repository's Node; the
		// development shell pins Bun, which also runs the fixture's TypeScript directly.
		ChildProcess.make('bun', [fixture, JSON.stringify(input)], {
			env: {
				PATH: process.env.PATH ?? '',
				HOME: at('home'),
				XDG_CONFIG_HOME: at('xdg', 'config'),
				XDG_DATA_HOME: at('xdg', 'data'),
				XDG_CACHE_HOME: at('xdg', 'cache'),
				XDG_STATE_HOME: at('xdg', 'state'),
				TMPDIR: at('tmp'),
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
	if (exitCode !== 0) return yield* Effect.die(new Error(`Embedded host failed:\n${stderr}`))
	return {
		report: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Report))(stdout.trim()),
		secret,
		hostOnly,
		isolatedData: yield* fs.exists(at('xdg', 'data', 'opencode')),
		checkoutsRemain: yield* Effect.forEach(checkouts, (directory) =>
			fs.exists(path.join(directory, 'source.txt')),
		),
	}
}, Effect.scoped)

const proveWorkspaces = async (runtime?: RuntimeSettings) => {
	const { report, secret, isolatedData, checkoutsRemain } = await Effect.runPromise(
		runEmbeddedHost(runtime).pipe(Effect.provide(NodeServices.layer)),
	)
	const [alpha, bravo] = report.workspaces
	if (!alpha || !bravo) throw new Error('Expected two workspaces')
	const unprovisioned = report.unprovisionedID
	const visibility = runtime ? 'hidden' : 'visible'

	expect(isolatedData).toBe(true)
	expect(alpha.id).not.toBe(bravo.id)
	for (const [workspace, other] of [
		[alpha, bravo],
		[bravo, alpha],
	] as const) {
		const { id, directory } = workspace
		expect(workspace.sessionWorkspaceID).toBe(id)
		expect(workspace.binding).toEqual({ id, directory })
		expect(workspace.userShell).toBe(id)
		expect(workspace.agentShell).toBe(`project:${id}:${visibility}`)
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
	expect(leaked).toHaveLength(runtime ? 0 : 2)

	expect([...report.operations].sort()).toEqual(
		[
			...[alpha.id, bravo.id].flatMap((id) => [`prepare:${id}`, `connect:${id}`, `connect:${id}`]),
			`purge:${bravo.id}`,
			`purge:${unprovisioned}`,
		].sort(),
	)
	expect(report.destroyed).toEqual({ destroyed: true })
	expect(report.phases).toEqual({
		[alpha.id]: 'ready',
		[bravo.id]: 'purged',
		[unprovisioned]: null,
	})
	expect(checkoutsRemain).toEqual([true, true])
	if (runtime) {
		for (const { id, directory } of report.workspaces) {
			const name = directory.split('/').at(-1)
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

const runtimeConfig = process.env.CAPSULE_TEST_RUNTIME

describe('OpenCode workspaces', () => {
	it(
		'route the embedded SDK through a controlled Capsule service',
		() => proveWorkspaces(),
		120_000,
	)

	// Set CAPSULE_TEST_RUNTIME to a runtime JSON file to run on the host's Bubblewrap and Nix daemon.
	it.skipIf(!runtimeConfig)(
		'route the embedded SDK through Bubblewrap Capsules',
		async () => {
			const runtime = await Effect.runPromise(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const json = yield* fs.readFileString(runtimeConfig ?? '')
					return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeSettings))(json)
				}).pipe(Effect.provide(NodeServices.layer)),
			)
			await proveWorkspaces(runtime)
		},
		300_000,
	)
})
