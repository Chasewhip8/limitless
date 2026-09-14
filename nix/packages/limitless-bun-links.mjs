import { lstat, readFile, readlink, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'

// Bun 1.3.13 lets canonical packages and their -cjs aliases race to replace these
// shared links. Keep package-local alias links intact and choose the lockfile's
// canonical resolutions for the shared links before Nix hashes the dependency tree.
export async function normalizeBunAliasLinks(directory) {
	const lockfile = Bun.JSONC.parse(await readFile(join(directory, 'bun.lock'), 'utf8'))
	const store = join(directory, 'node_modules', '.bun')

	for (const name of ['string-width', 'strip-ansi', 'wrap-ansi']) {
		const resolution = lockfile.packages?.[name]?.[0]
		if (typeof resolution !== 'string' || !resolution.startsWith(`${name}@`)) {
			throw new Error(`Missing canonical Bun lockfile resolution for ${name}`)
		}
		const version = resolution.slice(name.length + 1)
		const manifest = JSON.parse(
			await readFile(join(store, resolution, 'node_modules', name, 'package.json'), 'utf8'),
		)
		if (manifest.name !== name || manifest.version !== version) {
			throw new Error(`Installed package does not match Bun lockfile resolution ${resolution}`)
		}

		const link = join(store, 'node_modules', name)
		if (!(await lstat(link)).isSymbolicLink()) {
			throw new Error(`Expected a Bun shared dependency symlink at ${link}`)
		}
		const target = join('..', resolution, 'node_modules', name)
		if ((await readlink(link)) === target) continue
		await unlink(link)
		await symlink(target, link)
	}
}

if (import.meta.main) await normalizeBunAliasLinks(process.cwd())
