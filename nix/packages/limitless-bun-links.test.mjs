import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeBunAliasLinks } from './limitless-bun-links.mjs'

const packages = [
	{ name: 'string-width', version: '5.1.2', aliasVersion: '4.2.3' },
	{ name: 'strip-ansi', version: '7.2.0', aliasVersion: '6.0.1' },
	{ name: 'wrap-ansi', version: '8.1.0', aliasVersion: '7.0.0' },
]
const directories = []

afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true })
	}
})

async function fixture(useAlias) {
	const directory = await mkdtemp(join(tmpdir(), 'limitless-bun-links-'))
	directories.push(directory)
	const store = join(directory, 'node_modules', '.bun')
	const shared = join(store, 'node_modules')
	const local = join(store, '@isaacs+cliui@8.0.2', 'node_modules')
	await mkdir(shared, { recursive: true })
	await mkdir(local, { recursive: true })
	const resolutions = {}

	for (const { name, version, aliasVersion } of packages) {
		resolutions[name] = [`${name}@${version}`, '', {}, 'integrity']
		resolutions[`${name}-cjs`] = [`${name}@${aliasVersion}`, '', {}, 'integrity']
		for (const installedVersion of [version, aliasVersion]) {
			const installed = join(store, `${name}@${installedVersion}`, 'node_modules', name)
			await mkdir(installed, { recursive: true })
			await writeFile(
				join(installed, 'package.json'),
				JSON.stringify({ name, version: installedVersion }),
			)
		}
		await symlink(
			`../${name}@${useAlias ? aliasVersion : version}/node_modules/${name}`,
			join(shared, name),
		)
		await symlink(`../../${name}@${version}/node_modules/${name}`, join(local, name))
		await symlink(`../../${name}@${aliasVersion}/node_modules/${name}`, join(local, `${name}-cjs`))
	}
	// Bun lockfiles allow comments and trailing commas.
	await writeFile(
		join(directory, 'bun.lock'),
		`{ // fixture\n "packages": ${JSON.stringify(resolutions)},\n }`,
	)
	return { directory, store, shared, local }
}

test.each([false, true])('normalizes shared links (aliases: %s)', async (useAlias) => {
	const { directory, shared, local } = await fixture(useAlias)
	await normalizeBunAliasLinks(directory)
	await normalizeBunAliasLinks(directory)

	for (const { name, version, aliasVersion } of packages) {
		expect(await readlink(join(shared, name))).toBe(`../${name}@${version}/node_modules/${name}`)
		expect(await readlink(join(local, name))).toBe(`../../${name}@${version}/node_modules/${name}`)
		expect(await readlink(join(local, `${name}-cjs`))).toBe(
			`../../${name}@${aliasVersion}/node_modules/${name}`,
		)
	}
})

test('rejects a missing canonical lockfile resolution', async () => {
	const { directory } = await fixture(true)
	await writeFile(join(directory, 'bun.lock'), '{ "packages": {} }')
	await expect(normalizeBunAliasLinks(directory)).rejects.toThrow(
		'Missing canonical Bun lockfile resolution for string-width',
	)
})

test('rejects an installed package that disagrees with the lockfile', async () => {
	const { directory, store } = await fixture(true)
	await writeFile(
		join(store, 'string-width@5.1.2', 'node_modules', 'string-width', 'package.json'),
		JSON.stringify({ name: 'string-width', version: '4.2.3' }),
	)
	await expect(normalizeBunAliasLinks(directory)).rejects.toThrow(
		'Installed package does not match Bun lockfile resolution string-width@5.1.2',
	)
})

test('rejects a shared dependency that is not a symlink', async () => {
	const { directory, shared } = await fixture(true)
	await rm(join(shared, 'string-width'))
	await writeFile(join(shared, 'string-width'), 'unexpected file')
	await expect(normalizeBunAliasLinks(directory)).rejects.toThrow(
		'Expected a Bun shared dependency symlink',
	)
})
