import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
	access,
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const [capsule, runtimePath, nixpkgs, system, mode] = process.argv.slice(2)
assert(capsule && runtimePath && nixpkgs && system)
assert(mode === undefined || mode === '--without-namespaces', 'Unknown Capsule test mode')
const execute = promisify(execFile)
const settings = JSON.parse(await readFile(runtimePath, 'utf8'))
const directory = await realpath(await mkdtemp(join(tmpdir(), 'limitless-capsule-')))
const root = join(directory, 'state')
const checkout = join(directory, 'checkout')
const outside = join(directory, 'outside')
const secret = randomUUID()
const environment = {
	PATH: '/var/empty',
	HOME: join(directory, 'home'),
	CAPSULE_FIXTURE_SECRET: secret,
}

// Ends every remaining command before an outer runner abandons this process.
const deadline = AbortSignal.timeout(900000)

const run = async (file, args, options = {}) => {
	try {
		const { stdout, stderr } = await execute(file, args, {
			cwd: directory,
			env: environment,
			timeout: 600000,
			maxBuffer: 16 * 1024 * 1024,
			signal: deadline,
			...options,
		})
		return { code: 0, stdout, stderr }
	} catch (error) {
		if (typeof error.code !== 'number') throw error
		return { code: error.code, stdout: error.stdout, stderr: error.stderr }
	}
}
const succeed = async (args, options) => {
	const result = await run(capsule, args, options)
	assert.equal(
		result.code,
		0,
		`capsule ${args.join(' ')} failed:\n${result.stderr}${result.stdout}`,
	)
	return result.stdout
}
const manifest = async (args) => JSON.parse(await succeed(['--root', root, ...args]))
const lifecycle = async () =>
	(await readFile(join(checkout, 'lifecycle.log'), 'utf8')).trim().split('\n')

// Each tool a capsule's base PATH promises must start without host PATH entries.
const toolProbe = [
	'git --version',
	'gh --version',
	'rg --version',
	'nix --version',
	'docker --version',
	'docker compose version',
	'docker-compose version',
	'find --version',
	'test -z "$(command -v node || :)"',
].join('\n')

// Host Git for fixture repositories, without user or system configuration.
const findGit = async () => {
	for (const entry of settings.basePath.split(delimiter)) {
		const candidate = join(entry, 'git')
		if (
			await access(candidate, constants.X_OK).then(
				() => true,
				() => false,
			)
		)
			return candidate
	}
	assert.fail('The packaged base PATH has no Git')
}
const hostGit = async (...args) => {
	const result = await run(await findGit(), ['-c', 'core.hooksPath=/dev/null', ...args], {
		env: {
			PATH: settings.basePath,
			HOME: environment.HOME,
			GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_TERMINAL_PROMPT: '0',
			GIT_AUTHOR_NAME: 'Fixture',
			GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
			GIT_COMMITTER_NAME: 'Fixture',
			GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
		},
	})
	assert.equal(result.code, 0, `git ${args.join(' ')} failed:\n${result.stderr}`)
	return result.stdout.trimEnd()
}

/**
 * Serves bare repositories below `base` over git:// on loopback, one `git daemon --inetd` per
 * connection. Sandboxed commands share the host network, so they reach it from inside Bubblewrap.
 */
const serveGit = async (base) => {
	const git = await findGit()
	const daemons = new Set()
	const sockets = new Set()
	const server = createServer((socket) => {
		sockets.add(socket)
		socket.once('close', () => sockets.delete(socket))
		socket.on('error', () => socket.destroy())
		const daemon = spawn(
			git,
			['daemon', '--inetd', '--export-all', '--log-destination=none', `--base-path=${base}`],
			{
				env: { PATH: settings.basePath, HOME: environment.HOME },
				stdio: ['pipe', 'pipe', 'ignore'],
			},
		)
		daemons.add(daemon)
		daemon.once('exit', () => daemons.delete(daemon))
		daemon.on('error', () => socket.destroy())
		daemon.stdin.on('error', () => {})
		socket.pipe(daemon.stdin)
		daemon.stdout.pipe(socket)
	})
	await new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', resolve)
	})
	return {
		prefix: `git://127.0.0.1:${server.address().port}/`,
		close: async () => {
			const closed = new Promise((resolve) => server.close(resolve))
			for (const socket of sockets) socket.destroy()
			for (const daemon of daemons) daemon.kill('SIGKILL')
			await Promise.all(
				[...daemons].map((daemon) => new Promise((resolve) => daemon.once('exit', resolve))),
			)
			await closed
		},
	}
}

/** Files below `base` whose bytes contain any of `needles`. */
const filesContaining = async (base, needles) => {
	const found = []
	for (const entry of await readdir(base, { recursive: true })) {
		const file = join(base, entry)
		if (!(await lstat(file)).isFile()) continue
		const bytes = await readFile(file)
		if (needles.some((needle) => bytes.includes(needle))) found.push(file)
	}
	return found
}

// A dev shell without flake inputs, so creation never fetches nixpkgs; its derivation
// attributes become project environment variables.
const managedFlake = () => {
	const store = settings.shell.split('/').slice(0, 4).join('/')
	return `{
  outputs = { self }: {
    devShells.${system}.default = builtins.derivation {
      name = "capsule-managed-fixture";
      system = "${system}";
      builder = builtins.appendContext "${settings.shell}" { "${store}" = { path = true; }; };
      outputs = [ "out" ];
      CAPSULE_FIXTURE = "managed";
    };
  };
}
`
}

/**
 * Exercises the packaged create CLI against canonical GitHub URLs. A Git wrapper ahead of the
 * pinned base PATH redirects https://github.com/ to a loopback daemon, so origin keeps its
 * canonical URL while no GitHub request or real authentication happens.
 */
const managedCreate = async () => {
	const base = join(directory, 'managed')
	const seed = join(base, 'seed')
	const remotes = join(base, 'remotes')
	const state = join(base, 'state')
	const sources = join(base, 'sources')
	const tokenFile = join(base, 'secrets', 'token')
	const id = 'managed'
	const branch = 'task-branch'
	const repository = 'fixture/project'
	const canonical = `https://github.com/${repository}.git`
	const tokens = [
		`ghp_capsuleSmoke${randomUUID().replaceAll('-', '')}`,
		`ghp_capsuleRotated${randomUUID().replaceAll('-', '')}`,
	]
	const decoys = [
		`ghp_capsuleDecoy${randomUUID().replaceAll('-', '')}`,
		`ghp_capsuleDecoy${randomUUID().replaceAll('-', '')}`,
	]
	const identity = { name: 'Capsule Smoke', email: 'capsule-smoke@example.invalid' }
	await mkdir(join(base, 'secrets'), { recursive: true })
	await mkdir(join(base, 'capsule-git-redirect', 'bin'), { recursive: true })

	await hostGit('init', '-q', '-b', 'main', seed)
	const commit = async (files, message) => {
		for (const [name, content] of Object.entries(files)) await writeFile(join(seed, name), content)
		await hostGit('-C', seed, 'add', '.')
		await hostGit('-C', seed, 'commit', '-q', '-m', message)
		return hostGit('-C', seed, 'rev-parse', 'HEAD')
	}
	const record = (event) => ['bash', '-c', `echo ${event} >> "$CAPSULE_STATE_DIR/lifecycle.log"`]
	const initialSha = await commit(
		{
			'flake.nix': managedFlake(),
			'flake.lock': '{"nodes":{"root":{}},"root":"root","version":7}\n',
			'capsule.json': `${JSON.stringify({
				setup: [
					'bash',
					'-c',
					`if [ -n "\${GH_TOKEN:-}" ]; then auth=credentialed; else auth=anonymous; fi\n` +
						'echo "setup $(git rev-parse HEAD) $CAPSULE_FIXTURE $auth" >> "$CAPSULE_STATE_DIR/lifecycle.log"',
				],
				stop: record('stop'),
				purge: record('purge'),
			})}\n`,
			'README.md': 'initial\n',
		},
		'initial',
	)
	const mainSha = await commit({ 'README.md': 'main\n' }, 'main')
	await hostGit('init', '-q', '--bare', '-b', 'main', join(remotes, `${repository}.git`))
	await hostGit('-C', seed, 'push', '-q', join(remotes, `${repository}.git`), 'main')

	const daemon = await serveGit(remotes)
	try {
		// Only a loopback port and public store paths enter the store; credentials never do.
		const wrapper = join(base, 'capsule-git-redirect', 'bin', 'git')
		await writeFile(
			wrapper,
			`#!${settings.shell}\nexec ${await findGit()} -c url.${daemon.prefix}.insteadOf=https://github.com/ "$@"\n`,
		)
		await chmod(wrapper, 0o555)
		const added = await run(join(dirname(settings.nix), 'nix-store'), [
			'--add',
			join(base, 'capsule-git-redirect'),
		])
		assert.equal(added.code, 0, `Cannot add the Git redirect to the store:\n${added.stderr}`)
		const runtime = join(base, 'runtime.json')
		await writeFile(
			runtime,
			JSON.stringify({ ...settings, basePath: `${added.stdout.trim()}/bin:${settings.basePath}` }),
		)
		await writeFile(tokenFile, `${tokens[0]}\n`, { mode: 0o600 })

		const options = {
			env: { ...environment, GH_TOKEN: decoys[0], GITHUB_TOKEN: decoys[1] },
		}
		const globals = [
			'--root',
			state,
			'--runtime',
			runtime,
			'--checkout-root',
			sources,
			'--github-token-file',
			tokenFile,
			'--git-name',
			identity.name,
			'--git-email',
			identity.email,
		]
		const cli = async (...args) => JSON.parse(await succeed([...globals, ...args], options))
		const create = (...flags) =>
			cli('create', '--repo', repository, '--ref', 'main', '--branch', branch, '--id', id, ...flags)
		const shell = (script) => succeed([...globals, 'exec', id, '--', 'bash', '-c', script], options)
		const checkout = join(sources, id, 'checkout')
		const inCheckout = (...args) => hostGit('-C', checkout, ...args)
		const lifecycle = async () =>
			(
				await readFile(
					join(state, id, 'home', '.local', 'state', 'capsule', 'lifecycle.log'),
					'utf8',
				)
			)
				.trim()
				.split('\n')

		const created = await create()
		assert.deepEqual(created, {
			owner: 'limitless-capsule-v2',
			spec: { id, directory: checkout, project: created.spec.project },
			source: { root: sources, request: { id, repository, ref: 'main', branch }, commit: mainSha },
			generation: 1,
			phase: 'ready',
		})
		assert.deepEqual(await cli('inspect', id), created)
		assert.equal(await inCheckout('symbolic-ref', 'HEAD'), `refs/heads/${branch}`)
		assert.equal(await inCheckout('rev-parse', 'HEAD'), mainSha)
		assert.equal(await inCheckout('rev-parse', '--is-shallow-repository'), 'false')
		assert.equal(await inCheckout('rev-list', '--max-parents=0', 'HEAD'), initialSha)
		for (const direction of [[], ['--push']]) {
			assert.equal(await inCheckout('remote', 'get-url', ...direction, 'origin'), canonical)
		}
		for (const key of [`branch.${branch}.remote`, `branch.${branch}.merge`]) {
			assert.equal(await inCheckout('config', '--get', '--default', '', key), '')
		}
		assert.deepEqual(await lifecycle(), [`setup ${mainSha} managed credentialed`])

		// Git consults only the pinned GitHub CLI, which reads the token file for each command.
		const authenticated = async (token) => {
			const output = await shell(
				[
					'set -eu',
					`test "$PWD" = ${JSON.stringify(checkout)}`,
					`test -z "\${GITHUB_TOKEN:-}"`,
					'printf "%s\\n" "$(gh auth token)"',
					"printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill | sed -n 's/^password=//p'",
					'git var GIT_COMMITTER_IDENT | sed "s/>.*/>/"',
				].join('\n'),
			)
			assert.deepEqual(output.trim().split('\n'), [
				token,
				token,
				`${identity.name} <${identity.email}>`,
			])
		}
		await authenticated(tokens[0])
		await writeFile(tokenFile, `${tokens[1]}\n`, { mode: 0o600 })
		await authenticated(tokens[1])

		const head = (
			await shell(
				'set -e\necho work > work.txt\ngit add work.txt\ngit commit -q -m work\ngit rev-parse HEAD',
			)
		).trim()
		const retained = async () => {
			assert.equal(await inCheckout('rev-parse', 'HEAD'), head)
			assert.equal(await inCheckout('symbolic-ref', 'HEAD'), `refs/heads/${branch}`)
		}

		assert.deepEqual(await create(), created, 'Repeating create must resume, not reset, the source')
		await retained()
		const stopped = await cli('stop', id)
		assert.equal(stopped.phase, 'stopped')
		assert.deepEqual(stopped.source, created.source)
		const resumed = await create()
		assert.deepEqual(resumed, { ...created, generation: stopped.generation + 1 })
		await retained()
		const refreshed = await create('--refresh')
		assert.deepEqual(refreshed, { ...created, generation: resumed.generation + 1 })
		await retained()
		assert.deepEqual(await lifecycle(), [
			`setup ${mainSha} managed credentialed`,
			'stop',
			`setup ${head} managed credentialed`,
			`setup ${head} managed credentialed`,
		])

		const purged = await cli('purge', id)
		assert.deepEqual(purged, { ...refreshed, generation: purged.generation, phase: 'purged' })
		assert.deepEqual(await cli('inspect', id), purged)
		await retained()
		const ledger = JSON.parse(await readFile(join(sources, id, 'manifest.json'), 'utf8'))
		assert.deepEqual(
			{
				owner: ledger.owner,
				request: ledger.request,
				resolved: ledger.resolved,
				status: ledger.status,
			},
			{
				owner: 'limitless-source-v1',
				request: created.source.request,
				resolved: { kind: 'branch', commit: mainSha },
				status: { _tag: 'Ready', id, directory: checkout },
			},
		)
		const reused = await run(
			capsule,
			[...globals, 'create', '--repo', repository, '--ref', 'main', '--branch', branch, '--id', id],
			options,
		)
		assert.notEqual(reused.code, 0, 'A purged managed Capsule must not be reused')
		await retained()

		const needles = [...tokens, ...decoys].map((token) => Buffer.from(token))
		assert.deepEqual(
			await filesContaining(base, needles),
			[tokenFile],
			'Tokens must stay in the host token file',
		)
	} finally {
		await daemon.close()
	}
}

try {
	await mkdir(environment.HOME)
	await mkdir(checkout)
	await mkdir(outside)
	await writeFile(join(outside, 'host-only'), secret)

	const missingRoot = await run(capsule, ['inspect', 'fixture'])
	assert.notEqual(missingRoot.code, 0, 'Capsule must not guess a private state root')
	const nestedRoot = await run(capsule, [
		'--root',
		join(checkout, '.capsule'),
		'prepare',
		checkout,
		'--id',
		'nested',
	])
	assert.notEqual(nestedRoot.code, 0, 'Capsule state must stay outside the source checkout')
	assert.equal(await manifest(['inspect', 'fixture']), null)

	if (mode === '--without-namespaces') {
		const result = await run(settings.shell, ['-c', `set -eu\n${toolProbe}`], {
			env: { PATH: settings.basePath, HOME: environment.HOME },
		})
		assert.equal(result.code, 0, `The packaged base PATH is incomplete:\n${result.stderr}`)
	} else {
		await writeFile(
			join(checkout, 'flake.nix'),
			`{
  inputs.nixpkgs.url = "path:${nixpkgs}";
  outputs = { nixpkgs, ... }: let pkgs = nixpkgs.legacyPackages.${system}; in {
    devShells.${system}.default = pkgs.mkShellNoCC {
      packages = [ pkgs.hello ];
      CAPSULE_FIXTURE = "project";
    };
  };
}
`,
		)
		const record = (name) => ['bash', '-c', `echo ${name} >> lifecycle.log`]
		await writeFile(
			join(checkout, 'capsule.json'),
			JSON.stringify({ setup: record('setup'), stop: record('stop'), purge: record('purge') }),
		)
		const locked = await run(settings.nix, ['flake', 'lock', checkout], {
			env: { ...environment, PATH: settings.basePath },
		})
		assert.equal(locked.code, 0, `Cannot lock the fixture flake:\n${locked.stderr}`)

		const prepared = await manifest(['prepare', checkout, '--id', 'fixture'])
		assert.equal(prepared.phase, 'ready')
		assert.equal(prepared.spec.directory, checkout)
		assert.deepEqual(await lifecycle(), ['setup'])

		// Namespace setup failures must fail this check rather than skip it.
		const probe = await succeed([
			'--root',
			root,
			'exec',
			'fixture',
			'--',
			'bash',
			'-c',
			[
				'set -eu',
				toolProbe,
				`test "$PWD" = ${JSON.stringify(checkout)}`,
				'test "$CAPSULE_FIXTURE" = project',
				'hello > /dev/null',
				'test -z "$(printenv CAPSULE_FIXTURE_SECRET || :)"',
				`test "$HOME" != ${JSON.stringify(environment.HOME)}`,
				'touch "$HOME/written" exec-marker',
				`test ! -e ${JSON.stringify(join(outside, 'host-only'))}`,
				'readlink /proc/self/ns/pid',
			].join('\n'),
		])
		const namespace = probe.trim().split('\n').at(-1)
		assert.notEqual(
			namespace,
			await readlink('/proc/self/ns/pid'),
			'Commands must run in a new PID namespace',
		)
		await access(join(checkout, 'exec-marker'))

		const failed = await run(capsule, [
			'--root',
			root,
			'exec',
			'fixture',
			'--',
			'bash',
			'-c',
			'exit 7',
		])
		assert.equal(failed.code, 7, 'Capsule must report the command exit status')

		assert.equal((await manifest(['stop', 'fixture'])).phase, 'stopped')
		assert.equal((await lifecycle()).at(-1), 'stop')
		assert.equal((await manifest(['purge', 'fixture'])).phase, 'purged')
		assert.equal((await lifecycle()).at(-1), 'purge')
		await access(join(checkout, 'flake.nix'))
		const reused = await run(capsule, ['--root', root, 'prepare', checkout, '--id', 'fixture'])
		assert.notEqual(reused.code, 0, 'A purged Capsule identity must not be reused')

		await managedCreate()
	}
} finally {
	await rm(directory, { recursive: true, force: true })
}
