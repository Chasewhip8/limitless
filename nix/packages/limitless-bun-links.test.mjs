import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { normalizeBunAliasLinks } from './limitless-bun-links.mjs'

const packages = ['string-width', 'strip-ansi', 'wrap-ansi']

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), 'limitless-bun-links-'))
	t.after(() => rm(directory, { recursive: true, force: true }))
	const store = join(directory, 'node_modules', '.bun')
	await mkdir(join(store, 'node_modules'), { recursive: true })
	const lock = { packages: {} }
	for (const name of packages) {
		lock.packages[name] = [`${name}@1.0.0`]
		const canonical = join(store, `${name}@1.0.0`, 'node_modules', name)
		await mkdir(canonical, { recursive: true })
		await writeFile(join(canonical, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
		await symlink(`../${name}@0.0.0/node_modules/${name}`, join(store, 'node_modules', name))
	}
	const consumer = join(store, 'consumer@1.0.0', 'node_modules')
	await mkdir(consumer, { recursive: true })
	const alias = join(consumer, 'string-width-cjs')
	const aliasTarget = '../../string-width@0.0.0/node_modules/string-width'
	await symlink(aliasTarget, alias)
	const lockfile = join(directory, 'bun.lock')
	await writeFile(lockfile, JSON.stringify(lock))
	return { directory, store, lock, lockfile, alias, aliasTarget }
}

test('normalizes shared aliases without replacing package-local links or rewriting stable links', async (t) => {
	const files = await fixture(t)
	await normalizeBunAliasLinks(files.directory)
	for (const name of packages) {
		assert.equal(
			await readlink(join(files.store, 'node_modules', name)),
			`../${name}@1.0.0/node_modules/${name}`,
		)
	}
	assert.equal(await readlink(files.alias), files.aliasTarget)
	const stableLink = join(files.store, 'node_modules', packages[0])
	const before = await lstat(stableLink)
	await normalizeBunAliasLinks(files.directory)
	assert.equal((await lstat(stableLink)).ino, before.ino)
	assert.equal((await lstat(stableLink)).mtimeMs, before.mtimeMs)
})

test('rejects missing lockfile resolutions before replacing shared links', async (t) => {
	const files = await fixture(t)
	delete files.lock.packages['string-width']
	await writeFile(files.lockfile, JSON.stringify(files.lock))
	await assert.rejects(
		normalizeBunAliasLinks(files.directory),
		/Missing canonical Bun lockfile resolution/,
	)
	assert.equal(
		await readlink(join(files.store, 'node_modules', 'string-width')),
		'../string-width@0.0.0/node_modules/string-width',
	)
})

test('rejects installed metadata that disagrees with the lockfile before replacing its link', async (t) => {
	const files = await fixture(t)
	await writeFile(
		join(files.store, 'string-width@1.0.0', 'node_modules', 'string-width', 'package.json'),
		JSON.stringify({ name: 'string-width', version: '0.0.0' }),
	)
	await assert.rejects(
		normalizeBunAliasLinks(files.directory),
		/does not match Bun lockfile resolution/,
	)
	assert.equal(
		await readlink(join(files.store, 'node_modules', 'string-width')),
		'../string-width@0.0.0/node_modules/string-width',
	)
})
