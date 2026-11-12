import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const run = async (file, args, options = {}) => {
	try {
		const { stdout, stderr } = await execute(file, args, {
			cwd: directory,
			env: environment,
			timeout: 600000,
			maxBuffer: 16 * 1024 * 1024,
			...options,
		})
		return { code: 0, stdout, stderr }
	} catch (error) {
		if (typeof error.code !== 'number') throw error
		return { code: error.code, stdout: error.stdout, stderr: error.stderr }
	}
}
const succeed = async (args) => {
	const result = await run(capsule, args)
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
	'rg --version',
	'nix --version',
	'docker --version',
	'docker compose version',
	'docker-compose version',
	'find --version',
	'test -z "$(command -v node || :)"',
].join('\n')

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
	}
} finally {
	await rm(directory, { recursive: true, force: true })
}
