import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const target = `zed://ssh/user@host:22/home/user/my project;$HOME \${PATH} %h \`id\` 'q'`

afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true })
	}
})

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), 'limitless-t3-xdg-open-'))
	directories.push(directory)
	const systemdRun = join(directory, 'systemd-run')
	const xdgOpen = join(directory, 'xdg-open')
	await writeFile(systemdRun, recorder, { mode: 0o755 })
	await writeFile(xdgOpen, `#!/bin/sh\ntouch "${join(directory, 'opened-in-sandbox')}"\n`, {
		mode: 0o755,
	})
	const template = await readFile(new URL('./t3-xdg-open.sh', import.meta.url), 'utf8')
	const shim = join(directory, 'shim')
	await writeFile(
		shim,
		template.replaceAll('@systemdRun@', systemdRun).replaceAll('@xdgOpen@', xdgOpen),
	)
	const record = join(directory, 'record.json')
	return {
		directory,
		xdgOpen,
		openedInSandbox: () => existsSync(join(directory, 'opened-in-sandbox')),
		run(environment = {}, args = [target]) {
			const result = spawnSync('bash', [shim, ...args], {
				cwd: directory,
				encoding: 'utf8',
				env: {
					PATH: process.env.PATH,
					LD_LIBRARY_PATH: '/appimage/usr/lib',
					RECORD: record,
					...environment,
				},
			})
			return { status: result.status, stderr: result.stderr }
		},
		async record() {
			return JSON.parse(await readFile(record, 'utf8'))
		},
	}
}

test('opens through a transient user service with literal arguments', async () => {
	const { directory, xdgOpen, run, record } = await fixture()
	assert.deepEqual(run(), { status: 0, stderr: '' })
	const call = await record()
	assert.deepEqual(call.args, [
		'--user',
		'--quiet',
		'--collect',
		'--expand-environment=no',
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
	const { run, record } = await fixture()
	run({ XDG_ACTIVATION_TOKEN: 'activation-token', DESKTOP_STARTUP_ID: 'startup-id' })
	const call = await record()
	const forwarded = call.args.filter((arg) => arg.startsWith('--setenv'))
	assert.deepEqual(forwarded, ['--setenv=XDG_ACTIVATION_TOKEN'])
	assert.equal(call.env.XDG_ACTIVATION_TOKEN, 'activation-token')
	assert.ok(!call.args.some((arg) => arg.includes('activation-token')))
})

test('propagates a failed service start without opening in the sandbox', async () => {
	const { run, openedInSandbox } = await fixture()
	assert.equal(run({ RECORD_EXIT: '5' }).status, 5)
	assert.equal(openedInSandbox(), false)
})
