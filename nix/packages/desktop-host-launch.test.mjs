import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

const directories = []
const recorder = `#!${process.execPath}
const fs = require('node:fs')
fs.writeFileSync(process.env.RECORD, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
}))
process.exit(Number(process.env.RECORD_EXIT ?? 0))
`
// Editor fixtures search only their own directories, so resolve host tools first.
const hostTool = (name) =>
	spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()
const bash = hostTool('bash')
const readlink = hostTool('readlink')
const target = `zed://ssh/user@host:22/home/user/my project;$HOME \${PATH} %h \`id\` 'q'`

afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true })
	}
})

async function temporaryDirectory() {
	const directory = await mkdtemp(join(tmpdir(), 'limitless-desktop-host-'))
	directories.push(directory)
	return directory
}

async function executable(path, contents) {
	await writeFile(path, contents, { mode: 0o755 })
	return path
}

function runScript(script, args, environment, cwd) {
	const result = spawnSync(bash, [script, ...args], {
		cwd,
		encoding: 'utf8',
		env: { PATH: process.env.PATH, LD_LIBRARY_PATH: '/appimage/usr/lib', ...environment },
	})
	return { status: result.status, stderr: result.stderr }
}

async function launchFixture() {
	const directory = await temporaryDirectory()
	const systemdRun = await executable(join(directory, 'systemd-run'), recorder)
	const xdgOpen = await executable(
		join(directory, 'xdg-open'),
		`#!/bin/sh\ntouch "${join(directory, 'opened-in-sandbox')}"\n`,
	)
	const template = await readFile(new URL('./desktop-host-launch.sh', import.meta.url), 'utf8')
	const launch = join(directory, 'desktop-host-launch')
	await writeFile(launch, template.replaceAll('@systemdRun@', systemdRun))
	const record = join(directory, 'record.json')
	return {
		directory,
		xdgOpen,
		openedInSandbox: () => existsSync(join(directory, 'opened-in-sandbox')),
		run: (environment = {}) =>
			runScript(launch, [xdgOpen, target], { RECORD: record, ...environment }, directory),
		record: async () => JSON.parse(await readFile(record, 'utf8')),
	}
}

test('opens through a transient user service with literal arguments', async () => {
	const { directory, xdgOpen, run, record } = await launchFixture()
	assert.deepEqual(run(), { status: 0, stderr: '' })
	const call = await record()
	assert.deepEqual(call.args, [
		'--user',
		'--quiet',
		'--collect',
		'--expand-environment=no',
		'--description=Desktop handler',
		'--property=Type=exec',
		'--property=ExitType=cgroup',
		`--property=WorkingDirectory=-${directory}`,
		'--',
		xdgOpen,
		target,
	])
	assert.equal(call.env.LD_LIBRARY_PATH, undefined)
})

test('forwards only the activation token to the service', async () => {
	const { run, record } = await launchFixture()
	run({ XDG_ACTIVATION_TOKEN: 'activation-token', DESKTOP_STARTUP_ID: 'startup-id' })
	const call = await record()
	const forwarded = call.args.filter((arg) => arg.startsWith('--setenv'))
	assert.deepEqual(forwarded, ['--setenv=XDG_ACTIVATION_TOKEN'])
	assert.equal(call.env.XDG_ACTIVATION_TOKEN, 'activation-token')
	assert.ok(!call.args.some((arg) => arg.includes('activation-token')))
})

test('propagates a failed service start without opening in the sandbox', async () => {
	const { run, openedInSandbox } = await launchFixture()
	assert.equal(run({ RECORD_EXIT: '5' }).status, 5)
	assert.equal(openedInSandbox(), false)
})

// An editor command installed in `own`, searching `own` and then each host directory.
async function editorFixture(hostCommands, { aliases = [], inert = [] } = {}) {
	const directory = await temporaryDirectory()
	const own = join(directory, 'launchers')
	const store = join(directory, 'store')
	const profile = join(directory, 'profile')
	await Promise.all([own, store, profile].map((path) => mkdir(path)))
	const launch = await executable(join(directory, 'launch'), recorder)
	const template = await readFile(new URL('./desktop-host-editor.sh', import.meta.url), 'utf8')
	const editor = await executable(
		join(own, 'zed'),
		template
			.replaceAll('@launch@', launch)
			.replaceAll('@readlink@', readlink)
			.replaceAll('@candidates@', "'zeditor' 'zed'"),
	)
	// Host commands are profile symlinks into the store, as on NixOS.
	for (const name of hostCommands) {
		await executable(join(store, name), '#!/bin/sh\n')
		await symlink(join(store, name), join(profile, name))
	}
	for (const name of inert) await writeFile(join(profile, name), '#!/bin/sh\n', { mode: 0o644 })
	// Other spellings of the launcher directory, listed before the host profile.
	const ownAliases = {
		symlink: join(directory, 'launchers-link'),
		trailingSlash: `${own}/`,
		empty: '',
		relative: '.',
	}
	await symlink(own, ownAliases.symlink)
	const record = join(directory, 'record.json')
	return {
		directory,
		store,
		recorded: () => existsSync(record),
		run: () =>
			runScript(
				editor,
				['/home/user/project'],
				{
					RECORD: record,
					PATH: [own, ...aliases.map((alias) => ownAliases[alias]), profile].join(':'),
				},
				directory,
			),
		record: async () => JSON.parse(await readFile(record, 'utf8')),
	}
}

test('starts the first host candidate by its canonical path', async () => {
	const { store, run, record } = await editorFixture(['zed', 'zeditor'])
	assert.deepEqual(run(), { status: 0, stderr: '' })
	const call = await record()
	assert.deepEqual(call.args, [join(store, 'zeditor'), '/home/user/project'])
	assert.equal(call.env.LD_LIBRARY_PATH, undefined)
})

test('falls back to a later candidate without finding itself', async () => {
	const { store, run, record } = await editorFixture(['zed'])
	assert.equal(run().status, 0)
	assert.deepEqual((await record()).args, [join(store, 'zed'), '/home/user/project'])
})

test('fails without launching when no candidate is installed', async () => {
	const { run, recorded } = await editorFixture([])
	const result = run()
	assert.equal(result.status, 127)
	assert.match(result.stderr, /no host command found/)
	assert.equal(recorded(), false)
})

test('never searches the working directory', async () => {
	const { directory, run, recorded } = await editorFixture([], { aliases: ['empty', 'relative'] })
	await executable(join(directory, 'zeditor'), '#!/bin/sh\n')
	assert.equal(run().status, 127)
	assert.equal(recorded(), false)
})

test('skips itself under other spellings of its directory', async () => {
	const { store, run, record } = await editorFixture(['zed'], {
		aliases: ['symlink', 'trailingSlash'],
	})
	assert.equal(run().status, 0)
	assert.deepEqual((await record()).args, [join(store, 'zed'), '/home/user/project'])
})

test('skips a candidate that is not executable', async () => {
	const { store, run, record } = await editorFixture(['zed'], { inert: ['zeditor'] })
	assert.equal(run().status, 0)
	assert.deepEqual((await record()).args, [join(store, 'zed'), '/home/user/project'])
})
