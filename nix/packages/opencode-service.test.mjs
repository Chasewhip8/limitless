import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { prepareService } from './opencode-service.mjs'

const directories = []
const launcher = fileURLToPath(new URL('./opencode-service.mjs', import.meta.url))
const fakeCLI = `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const file = path.join(process.env.SERVICE_FIXTURE, 'state.json')
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2)
state.calls.push(args)
fs.writeFileSync(file, JSON.stringify(state))
if (args.join(' ') === state.fail) process.exit(7)
if (args[0] === 'serve') {
  process.stdout.write(JSON.stringify({
    pid: process.pid,
    args,
    token: process.env.TEST_TOKEN,
    inherited: process.env.TEST_INHERITED,
    override: process.env.TEST_OVERRIDE,
  }))
} else if (args[0] === 'service' && args[1] === 'get') {
  const value = args[2] === 'env'
    ? state.rawEnvironment ?? JSON.stringify(state.config.env ?? {})
    : String(state.config[args[2]] ?? '')
  process.stdout.write(value + '\\n')
} else if (args[0] === 'service' && args[1] === 'set') {
  state.config[args[2]] = args[2] === 'port' ? Number(args[3]) : args[3]
  state.running = false
  fs.writeFileSync(file, JSON.stringify(state))
} else if (args[0] === 'service' && args[1] === 'stop') {
  state.running = false
  fs.writeFileSync(file, JSON.stringify(state))
} else {
  process.exit(2)
}
`

afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true })
	}
})

async function fixture(config = {}, overrides = {}) {
	const directory = await mkdtemp(join(tmpdir(), 'limitless-opencode-service-'))
	directories.push(directory)
	const opencode = join(directory, 'opencode')
	const stateFile = join(directory, 'state.json')
	await writeFile(opencode, fakeCLI, { mode: 0o755 })
	await writeFile(stateFile, JSON.stringify({ config, calls: [], running: true, ...overrides }))
	return {
		opencode,
		environment: {
			SERVICE_FIXTURE: directory,
			TEST_INHERITED: 'inherited',
			TEST_OVERRIDE: 'original',
		},
		async state() {
			return JSON.parse(await readFile(stateFile, 'utf8'))
		},
	}
}

test('matching settings avoid writes and still reclaim the native daemon', async () => {
	const config = {
		hostname: '127.0.0.1',
		port: 4096,
		password: 'fixture-password',
		cors: ['https://example.ts.net'],
	}
	const instance = await fixture(config)
	prepareService(instance.opencode, config.hostname, config.port, instance.environment)
	const state = await instance.state()
	assert.deepEqual(state.config, config)
	assert.equal(state.running, false)
	assert.deepEqual(state.calls, [
		['service', 'get', 'env'],
		['service', 'get', 'hostname'],
		['service', 'get', 'port'],
		['service', 'stop'],
	])
})

test('persists changed settings while preserving unrelated private configuration', async () => {
	const config = {
		hostname: '0.0.0.0',
		port: 49374,
		password: 'fixture-password',
		cors: ['https://example.ts.net'],
		env: { TEST_TOKEN: 'fixture-token' },
	}
	const instance = await fixture(config)
	prepareService(instance.opencode, '127.0.0.1', 4096, instance.environment)
	const state = await instance.state()
	assert.deepEqual(state.config, { ...config, hostname: '127.0.0.1', port: 4096 })
	assert.deepEqual(
		state.calls.filter((args) => args[1] === 'set'),
		[
			['service', 'set', 'hostname', '127.0.0.1'],
			['service', 'set', 'port', '4096'],
		],
	)
	prepareService(instance.opencode, '127.0.0.1', 4096, instance.environment)
	const repeated = await instance.state()
	assert.equal(repeated.calls.filter((args) => args[1] === 'set').length, 2)
	assert.equal(repeated.calls.filter((args) => args[1] === 'stop').length, 2)
})

test('writes only the differing setting', async () => {
	const instance = await fixture({ hostname: '127.0.0.1', port: 49374 })
	prepareService(instance.opencode, '127.0.0.1', 4096, instance.environment)
	assert.deepEqual(
		(await instance.state()).calls.filter((args) => args[1] === 'set'),
		[['service', 'set', 'port', '4096']],
	)
})

test('initializes absent settings with the declared binding', async () => {
	const instance = await fixture()
	prepareService(instance.opencode, '127.0.0.1', 4096, instance.environment)
	assert.deepEqual((await instance.state()).config, { hostname: '127.0.0.1', port: 4096 })
})

test('preserves native environment precedence and arbitrary string values', async () => {
	const env = {
		TEST_TOKEN: 'spaces "quotes"\nnewlines $(commands)',
		TEST_OVERRIDE: 'configured',
		TEST_EMPTY: '',
	}
	const instance = await fixture({ env })
	const environment = prepareService(instance.opencode, '127.0.0.1', 4096, instance.environment)
	assert.deepEqual(environment, { ...instance.environment, ...env })
	assert.equal(instance.environment.TEST_OVERRIDE, 'original')
})

for (const fail of ['service get env', 'service set hostname 127.0.0.1', 'service stop']) {
	test(`propagates failure of ${fail}`, async () => {
		const instance = await fixture({}, { fail })
		assert.throws(
			() => prepareService(instance.opencode, '127.0.0.1', 4096, instance.environment),
			/OpenCode service .* failed \(7\)/,
		)
		assert.equal((await instance.state()).calls.at(-1).join(' '), fail)
	})
}

for (const rawEnvironment of [
	'{"TEST_TOKEN":"fixture-private-value", invalid}',
	'null',
	'[]',
	'{"TOKEN": 123}',
	'{"": "value"}',
	'{"BAD=KEY": "value"}',
	'{"TOKEN": "nul\\u0000value"}',
]) {
	test(`rejects invalid environment before mutating the service: ${rawEnvironment}`, async () => {
		const instance = await fixture({}, { rawEnvironment })
		assert.throws(
			() => prepareService(instance.opencode, '127.0.0.1', 4096, instance.environment),
			(error) => {
				assert.match(error.message, /invalid service environment|invalid service environment JSON/)
				assert.equal(error.message.includes('fixture-private-value'), false)
				return true
			},
		)
		assert.deepEqual((await instance.state()).calls, [['service', 'get', 'env']])
		assert.equal((await instance.state()).running, true)
	})
}

test('executes foreground native service in the launcher process with the private environment', async () => {
	const instance = await fixture({
		env: { TEST_TOKEN: 'fixture-token', TEST_OVERRIDE: 'configured' },
	})
	const result = spawnSync(process.execPath, [launcher, instance.opencode, '127.0.0.1', '4096'], {
		env: instance.environment,
		encoding: 'utf8',
	})
	assert.equal(result.status, 0, result.stderr)
	assert.deepEqual(JSON.parse(result.stdout), {
		pid: result.pid,
		args: ['serve', '--service', '--hostname', '127.0.0.1', '--port', '4096'],
		token: 'fixture-token',
		inherited: 'inherited',
		override: 'configured',
	})
})

test('does not launch a server after preparation fails', async () => {
	const instance = await fixture({}, { fail: 'service stop' })
	const result = spawnSync(process.execPath, [launcher, instance.opencode, '127.0.0.1', '4096'], {
		env: instance.environment,
		encoding: 'utf8',
	})
	assert.notEqual(result.status, 0)
	assert.equal(result.stdout, '')
	assert.equal(
		(await instance.state()).calls.some((args) => args[0] === 'serve'),
		false,
	)
})
