import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { configureT3 } from './t3-settings.mjs'

async function fixture(t) {
	const temporary = process.env.TMPDIR ?? '/tmp/opencode'
	await mkdir(temporary, { recursive: true })
	const directory = await mkdtemp(join(temporary, 'limitless-t3-settings-'))
	t.after(() => rm(directory, { recursive: true, force: true }))
	const userdata = join(directory, 'userdata')
	await mkdir(userdata)
	return {
		directory,
		settings: join(userdata, 'settings.json'),
		desktop: join(userdata, 'desktop-settings.json'),
		runtime: join(userdata, 'server-runtime.json'),
	}
}

const binary = '/home/test/.nix-profile/bin/opencode-t3'
const json = async (path) => JSON.parse(await readFile(path, 'utf8'))

test('provisions a new headless environment and a remote-only desktop', async (t) => {
	const files = await fixture(t)
	assert.equal(await configureT3(files.directory, binary), true)
	assert.deepEqual(await json(files.settings), {
		providerInstances: {
			opencode: { driver: 'opencode', enabled: true, config: { binaryPath: binary } },
		},
	})
	assert.deepEqual(await json(files.desktop), { localEnvironmentEnabled: false })
	assert.equal((await stat(files.settings)).mode & 0o777, 0o600)
})

test('preserves unknown settings, accounts, credentials and provider fields', async (t) => {
	const files = await fixture(t)
	const provider = {
		driver: 'opencode',
		enabled: false,
		displayName: 'My OpenCode',
		environment: [
			{ name: 'CUSTOM', value: 'retained', sensitive: false },
			{ name: 'SECRET', value: '', sensitive: true, valueRedacted: true },
		],
		config: {
			enabled: false,
			serverUrl: 'http://old.example',
			serverPassword: 'fixture-secret',
			customModels: ['kept'],
		},
	}
	const original = {
		newerSetting: { value: 1 },
		providerInstances: {
			opencode: provider,
			other: { driver: 'other', config: { account: 'retained' } },
		},
	}
	await writeFile(files.settings, JSON.stringify(original), { mode: 0o640 })
	await writeFile(
		files.desktop,
		JSON.stringify({ windowBounds: { width: 1200 }, localEnvironmentEnabled: true }),
		{ mode: 0o640 },
	)
	await configureT3(files.directory, binary)
	const updated = await json(files.settings)
	assert.deepEqual(updated.newerSetting, original.newerSetting)
	assert.deepEqual(updated.providerInstances.other, original.providerInstances.other)
	assert.deepEqual(updated.providerInstances.opencode, {
		...provider,
		enabled: true,
		config: {
			serverUrl: '',
			serverPassword: 'fixture-secret',
			customModels: ['kept'],
			binaryPath: binary,
		},
	})
	assert.deepEqual(await json(files.desktop), {
		windowBounds: { width: 1200 },
		localEnvironmentEnabled: false,
	})
	assert.equal((await stat(files.settings)).mode & 0o777, 0o640)
	assert.equal((await stat(files.desktop)).mode & 0o777, 0o640)
})

test('unchanged settings are a no-op', async (t) => {
	const files = await fixture(t)
	await configureT3(files.directory, binary)
	const before = await readFile(files.settings, 'utf8')
	assert.equal(await configureT3(files.directory, binary), false)
	assert.equal(await readFile(files.settings, 'utf8'), before)
})

test('refuses changed settings while a runtime PID is alive', async (t) => {
	const files = await fixture(t)
	await writeFile(files.settings, '{}')
	await writeFile(files.desktop, '{}')
	await writeFile(files.runtime, JSON.stringify({ pid: process.pid }))
	await assert.rejects(configureT3(files.directory, binary), (error) => {
		assert.ok(error.message.includes(`live PID ${process.pid}`))
		assert.ok(error.message.includes(files.runtime))
		assert.match(error.message, /Close the T3 desktop/)
		return true
	})
	assert.equal(await readFile(files.settings, 'utf8'), '{}')
	assert.equal(await readFile(files.desktop, 'utf8'), '{}')
})

for (const contents of [
	'{ broken',
	'[]',
	'{/* comment */}',
	'{"providerInstances":[]}',
	'{"providerInstances":{"opencode":{"driver":"other"}}}',
	'{"providerInstances":{"opencode":{"config":false}}}',
]) {
	test(`rejects incompatible settings without rewriting them: ${contents}`, async (t) => {
		const files = await fixture(t)
		await writeFile(files.settings, contents)
		await writeFile(files.desktop, '{}')
		await assert.rejects(configureT3(files.directory, binary))
		assert.equal(await readFile(files.settings, 'utf8'), contents)
		assert.equal(await readFile(files.desktop, 'utf8'), '{}')
	})
}

test('refuses symlinks and malformed runtime records', async (t) => {
	const files = await fixture(t)
	const target = join(files.directory, 'target.json')
	await writeFile(target, '{}')
	await symlink(target, files.settings)
	await assert.rejects(configureT3(files.directory, binary), /non-regular/)
	assert.equal(await readFile(target, 'utf8'), '{}')
	await rm(files.settings)
	await writeFile(files.runtime, '{}')
	await assert.rejects(configureT3(files.directory, binary), /runtime PID/)
})

test('retains legacy OpenCode configuration when introducing the default instance', async (t) => {
	const files = await fixture(t)
	const legacy = {
		enabled: false,
		serverUrl: 'http://old.example',
		customModels: ['kept'],
		serverPassword: 'fixture-secret',
	}
	await writeFile(
		files.settings,
		JSON.stringify({ providers: { opencode: legacy, other: { untouched: true } } }),
	)
	await configureT3(files.directory, binary)
	const updated = await json(files.settings)
	assert.deepEqual(updated.providers, { opencode: legacy, other: { untouched: true } })
	assert.deepEqual(updated.providerInstances.opencode, {
		driver: 'opencode',
		enabled: true,
		config: {
			serverUrl: '',
			customModels: ['kept'],
			serverPassword: 'fixture-secret',
			binaryPath: binary,
		},
	})
})

test('an explicit instance wins over legacy provider configuration', async (t) => {
	const files = await fixture(t)
	await writeFile(
		files.settings,
		JSON.stringify({
			providers: { opencode: { customModels: ['legacy'] } },
			providerInstances: { opencode: { config: { customModels: ['current'], enabled: true } } },
		}),
	)
	await configureT3(files.directory, binary)
	assert.deepEqual((await json(files.settings)).providerInstances.opencode.config, {
		customModels: ['current'],
		binaryPath: binary,
	})
})

for (const serverUrl of [undefined, '', '  ']) {
	test(`preserves compliant settings byte-for-byte with serverUrl ${JSON.stringify(serverUrl)}`, async (t) => {
		const files = await fixture(t)
		const original = JSON.stringify(
			{
				providerInstances: {
					opencode: {
						driver: 'opencode',
						enabled: true,
						config: { binaryPath: binary, serverUrl },
					},
				},
			},
			null,
			4,
		)
		await writeFile(files.settings, original)
		await writeFile(files.desktop, '{ "localEnvironmentEnabled": false }')
		assert.equal(await configureT3(files.directory, binary), false)
		assert.equal(await readFile(files.settings, 'utf8'), original)
		assert.equal(await readFile(files.desktop, 'utf8'), '{ "localEnvironmentEnabled": false }')
	})
}

test('opting out of provider management does not read or write server settings', async (t) => {
	const files = await fixture(t)
	await writeFile(files.settings, '{ /* intentionally not plain JSON */ }')
	await configureT3(files.directory, binary, { manageOpenCode: false })
	assert.equal(await readFile(files.settings, 'utf8'), '{ /* intentionally not plain JSON */ }')
	assert.deepEqual(await json(files.desktop), { localEnvironmentEnabled: false })
})

test('the startup command refuses a live PID even when settings already comply', async (t) => {
	const files = await fixture(t)
	await configureT3(files.directory, binary)
	await writeFile(files.runtime, JSON.stringify({ pid: process.pid }))
	await assert.rejects(
		promisify(execFile)(process.execPath, [
			fileURLToPath(new URL('./t3-settings.mjs', import.meta.url)),
			files.directory,
			binary,
		]),
		/Close the T3 desktop/,
	)
})

test('rejects whitespace around the home before reading or creating files', async (t) => {
	const files = await fixture(t)
	const home = join(files.directory, 'home')
	await mkdir(join(home, 'userdata'), { recursive: true })
	await writeFile(join(home, 'userdata/server-runtime.json'), JSON.stringify({ pid: process.pid }))
	await writeFile(join(home, 'userdata/desktop-settings.json'), '{"localEnvironmentEnabled":true}')
	for (const path of [`${home} `, `${home}\n`, `${home}\u00a0`, ` ${home}`]) {
		await assert.rejects(configureT3(path, binary), /surrounding whitespace/)
		await assert.rejects(stat(path), { code: 'ENOENT' })
	}
	assert.deepEqual(await json(join(home, 'userdata/desktop-settings.json')), {
		localEnvironmentEnabled: true,
	})
})

test('a stale PID permits provisioning without sending a signal', async (t) => {
	const files = await fixture(t)
	await writeFile(files.runtime, JSON.stringify({ pid: 12345 }))
	const probe = t.mock.method(process, 'kill', (pid, signal) => {
		assert.equal(pid, 12345)
		assert.equal(signal, 0)
		throw Object.assign(new Error('No such process'), { code: 'ESRCH' })
	})
	assert.equal(await configureT3(files.directory, binary), true)
	assert.equal(probe.mock.callCount(), 1)
})

test('an inaccessible live PID blocks provisioning', async (t) => {
	const files = await fixture(t)
	await writeFile(files.settings, '{}')
	await writeFile(files.desktop, '{}')
	await writeFile(files.runtime, JSON.stringify({ pid: 12345 }))
	t.mock.method(process, 'kill', () => {
		throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' })
	})
	await assert.rejects(configureT3(files.directory, binary), (error) => {
		assert.ok(error.message.includes('live PID 12345'))
		assert.ok(error.message.includes(files.runtime))
		assert.match(error.message, /EPERM/)
		return true
	})
	assert.equal(await readFile(files.settings, 'utf8'), '{}')
	assert.equal(await readFile(files.desktop, 'utf8'), '{}')
})

test('malformed runtime JSON leaves both settings files untouched', async (t) => {
	const files = await fixture(t)
	await writeFile(files.runtime, '{')
	await writeFile(files.settings, '{}')
	await writeFile(files.desktop, '{}')
	await assert.rejects(configureT3(files.directory, binary), /Cannot verify/)
	assert.equal(await readFile(files.settings, 'utf8'), '{}')
	assert.equal(await readFile(files.desktop, 'utf8'), '{}')
})

for (const kind of ['symlink', 'directory']) {
	test(`refuses a desktop settings ${kind} without changing provider settings`, async (t) => {
		const files = await fixture(t)
		await writeFile(files.settings, '{}')
		if (kind === 'symlink') {
			const target = join(files.directory, 'target.json')
			await writeFile(target, '{}')
			await symlink(target, files.desktop)
		} else {
			await mkdir(files.desktop)
		}
		await assert.rejects(configureT3(files.directory, binary), /non-regular/)
		assert.equal(await readFile(files.settings, 'utf8'), '{}')
	})
}

test('timestamps and unsupported versions never authorize bypassing a live PID', async (t) => {
	const files = await fixture(t)
	await configureT3(files.directory, binary)
	const before = await readFile(files.settings, 'utf8')
	for (const version of [1, 999]) {
		for (const startedAt of ['1960-01-01T00:00:00Z', '2099-01-01T00:00:00Z']) {
			await writeFile(files.runtime, JSON.stringify({ version, pid: process.pid, startedAt }))
			await assert.rejects(configureT3(files.directory, binary), /live PID/)
		}
	}
	assert.equal(await readFile(files.settings, 'utf8'), before)
})
