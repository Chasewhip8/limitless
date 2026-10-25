import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { configurePaseo, writtenDuringThisBoot } from './paseo-settings.mjs'

async function fixture(t) {
	const temporary = process.env.TMPDIR ?? '/tmp/opencode'
	await mkdir(temporary, { recursive: true })
	const home = await mkdtemp(join(temporary, 'limitless-paseo-settings-'))
	t.after(() => rm(home, { recursive: true, force: true }))
	return { home, config: join(home, 'config.json'), lock: join(home, 'paseo.pid') }
}

const settings = {
	listen: '127.0.0.1:6767',
	launcher: '/home/test/.nix-profile/bin/opencode-paseo',
	browserTools: true,
}
const json = async (path) => JSON.parse(await readFile(path, 'utf8'))

test('provisions a new home with the managed daemon and OpenCode provider', async (t) => {
	const files = await fixture(t)
	assert.equal(await configurePaseo(files.home, settings), true)
	assert.deepEqual(await json(files.config), {
		version: 1,
		daemon: {
			listen: '127.0.0.1:6767',
			relay: { enabled: false },
			mcp: { enabled: true, injectIntoAgents: true },
			browserTools: { enabled: true },
		},
		agents: {
			providers: { opencode: { enabled: true, command: [settings.launcher] } },
		},
	})
	assert.equal((await stat(files.config)).mode & 0o777, 0o600)
	assert.equal(await configurePaseo(files.home, settings), false)
})

test('preserves the password hash, profiles and unmanaged settings', async (t) => {
	const files = await fixture(t)
	const original = {
		version: 1,
		daemon: {
			listen: '0.0.0.0:7000',
			auth: { password: '$2b$12$fixturehash' },
			relay: { enabled: true, endpoint: 'relay.example:443' },
			mcp: { enabled: false },
			appendSystemPrompt: 'kept',
		},
		agents: {
			providers: {
				opencode: { command: ['/old/opencode'], paseoTools: { disabledTools: ['speak'] } },
				'codex-worker': { extends: 'codex', label: 'Codex Worker' },
			},
		},
		newerSetting: { value: 1 },
	}
	await writeFile(files.config, JSON.stringify(original), { mode: 0o640 })
	assert.equal(await configurePaseo(files.home, { ...settings, browserTools: false }), true)
	const result = await json(files.config)
	assert.equal(result.daemon.auth.password, '$2b$12$fixturehash')
	assert.equal(result.daemon.appendSystemPrompt, 'kept')
	assert.deepEqual(result.daemon.relay, { enabled: false, endpoint: 'relay.example:443' })
	assert.deepEqual(result.daemon.mcp, { enabled: true, injectIntoAgents: true })
	assert.deepEqual(result.daemon.browserTools, { enabled: false })
	assert.deepEqual(result.agents.providers.opencode, {
		command: [settings.launcher],
		paseoTools: { disabledTools: ['speak'] },
		enabled: true,
	})
	assert.deepEqual(
		result.agents.providers['codex-worker'],
		original.agents.providers['codex-worker'],
	)
	assert.deepEqual(result.newerSetting, { value: 1 })
	assert.equal((await stat(files.config)).mode & 0o777, 0o640)
})

test('refuses a live daemon but ignores stale and empty locks', async (t) => {
	const files = await fixture(t)
	await writeFile(files.lock, JSON.stringify({ pid: process.pid, startedAt: 'now' }))
	await assert.rejects(configurePaseo(files.home, settings), /live PID/)
	await writeFile(files.lock, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: 'now' }))
	assert.equal(await configurePaseo(files.home, settings), true)
	await writeFile(files.lock, '')
	assert.equal(await configurePaseo(files.home, settings), false)
	await writeFile(files.lock, '{broken')
	await assert.rejects(configurePaseo(files.home, settings), /Cannot verify/)
})

test('a lock from an earlier boot is abandoned even when its PID is reused', async (t) => {
	const files = await fixture(t)
	const startedAt = new Date().toISOString()
	await writeFile(
		files.lock,
		JSON.stringify({ pid: process.pid, startedAt, bootId: 'earlier-boot' }),
	)
	assert.equal(
		writtenDuringThisBoot({ pid: process.pid, startedAt, bootId: 'earlier-boot' }, 'this-boot'),
		false,
	)
	assert.equal(
		writtenDuringThisBoot({ pid: process.pid, startedAt, bootId: 'this-boot' }, 'this-boot'),
		true,
	)
	assert.equal(
		writtenDuringThisBoot({ pid: process.pid, startedAt: '2000-01-01T00:00:00Z' }, undefined),
		false,
	)
	assert.equal(writtenDuringThisBoot({ pid: process.pid, startedAt }, undefined), true)
	// The host's real boot ID never equals the fixture's.
	assert.equal(await configurePaseo(files.home, settings), true)
})

test('accepts a configuration with a byte-order mark, as Paseo does', async (t) => {
	const files = await fixture(t)
	await writeFile(
		files.config,
		`\uFEFF${JSON.stringify({ daemon: { auth: { password: 'hash' } } })}`,
	)
	assert.equal(await configurePaseo(files.home, settings), true)
	assert.equal((await json(files.config)).daemon.auth.password, 'hash')
})

test('refuses symlinks, malformed config and relative paths', async (t) => {
	const files = await fixture(t)
	await writeFile(join(files.home, 'real.json'), '{}')
	await symlink(join(files.home, 'real.json'), files.config)
	await assert.rejects(configurePaseo(files.home, settings), /non-regular/)
	await rm(files.config)
	await writeFile(files.config, '// comment\n{}')
	await assert.rejects(configurePaseo(files.home, settings), /valid plain JSON/)
	await writeFile(files.config, JSON.stringify({ daemon: [] }))
	await assert.rejects(configurePaseo(files.home, settings), /daemon must be a JSON object/)
	await assert.rejects(configurePaseo('relative', settings), /absolute/)
	await assert.rejects(
		configurePaseo(files.home, { ...settings, launcher: 'opencode-paseo' }),
		/absolute/,
	)
})
