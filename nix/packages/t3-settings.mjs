import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function objectField(object, key) {
	const value = object[key]
	if (value === undefined) return {}
	if (!isObject(value)) throw new Error(`T3 ${key} must be a JSON object`)
	return value
}

async function document(path) {
	try {
		const status = await lstat(path)
		if (!status.isFile() || status.isSymbolicLink()) {
			throw new Error(`Refusing to replace a non-regular T3 settings file: ${path}`)
		}
		const text = await readFile(path, 'utf8')
		let value
		try {
			value = JSON.parse(text)
		} catch {
			throw new Error(`T3 settings must be valid plain JSON before provisioning: ${path}`)
		}
		if (!isObject(value)) throw new Error(`T3 settings must contain a JSON object: ${path}`)
		return { path, value, mode: status.mode & 0o777, text }
	} catch (error) {
		if (error.code === 'ENOENT') return { path, value: {}, mode: 0o600, text: undefined }
		throw error
	}
}

async function requireStopped(path) {
	let text
	try {
		text = await readFile(path, 'utf8')
	} catch (error) {
		if (error.code === 'ENOENT') return
		throw error
	}
	let runtime
	try {
		runtime = JSON.parse(text)
	} catch {
		throw new Error(`Cannot verify whether T3 is stopped: ${path}`)
	}
	if (!isObject(runtime) || !Number.isSafeInteger(runtime.pid) || runtime.pid <= 0) {
		throw new Error(`Invalid T3 runtime PID record: ${path}`)
	}
	let probeDenied = false
	try {
		process.kill(runtime.pid, 0)
	} catch (error) {
		if (error.code === 'ESRCH') return
		if (error.code !== 'EPERM') throw error
		probeDenied = true
	}
	throw new Error(
		`T3 runtime record ${path} refers to live PID ${runtime.pid}${probeDenied ? ' (process probe denied: EPERM)' : ''}. ` +
			'Close the T3 desktop and stop the headless T3 service before starting the managed T3 service. ' +
			'If a crash left a reused PID, stop service retries and verify no T3 backend uses this home before moving only the stale runtime record aside.',
	)
}

async function replaceDocument(original, value) {
	const directory = dirname(original.path)
	await mkdir(directory, { recursive: true, mode: 0o700 })
	const temporary = join(directory, `.limitless-t3-${randomUUID()}.tmp`)
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
		await chmod(temporary, original.mode)
		const current = await document(original.path)
		if (current.text !== original.text || current.mode !== original.mode) {
			throw new Error('T3 settings changed during provisioning; stop T3 and try again')
		}
		await rename(temporary, original.path)
	} finally {
		await unlink(temporary).catch((error) => {
			if (error.code !== 'ENOENT') throw error
		})
	}
}

export async function configureT3(baseDirectory, binaryPath, { manageOpenCode = true } = {}) {
	// T3 trims the CLI path. Reject that ambiguity instead of provisioning a
	// different home from the one whose runtime PID and data T3 will actually use.
	if (!isAbsolute(baseDirectory) || baseDirectory !== baseDirectory.trim()) {
		throw new Error('T3 base directory must be absolute with no surrounding whitespace')
	}
	const userdata = join(baseDirectory, 'userdata')
	// Atomic replacement cannot lock out T3's in-process writer. The startup
	// command must refuse a live environment even when its settings already match.
	await requireStopped(join(userdata, 'server-runtime.json'))
	const desktop = await document(join(userdata, 'desktop-settings.json'))
	const desktopSettings = { ...desktop.value, localEnvironmentEnabled: false }
	const candidates = [[desktop, desktopSettings]]
	if (manageOpenCode) {
		const server = await document(join(userdata, 'settings.json'))
		const providers = objectField(server.value, 'providerInstances')
		// T3 prefers an explicit instance over its legacy provider blob. Preserve
		// that blob when introducing the instance so T3's migration cannot drop it.
		const existing =
			providers.opencode === undefined
				? { config: objectField(objectField(server.value, 'providers'), 'opencode') }
				: objectField(providers, 'opencode')
		if (existing.driver !== undefined && existing.driver !== 'opencode') {
			throw new Error(
				'The T3 opencode provider ID belongs to another driver; resolve it before provisioning',
			)
		}
		const config = { ...objectField(existing, 'config'), binaryPath }
		if (config.serverUrl !== undefined) {
			if (typeof config.serverUrl !== 'string')
				throw new Error('T3 OpenCode serverUrl must be a string')
			if (config.serverUrl.trim() !== '') config.serverUrl = ''
		}
		delete config.enabled
		candidates.push([
			server,
			{
				...server.value,
				providerInstances: {
					...providers,
					opencode: { ...existing, driver: 'opencode', enabled: true, config },
				},
			},
		])
	}
	const updates = candidates.filter(
		([original, value]) => JSON.stringify(original.value) !== JSON.stringify(value),
	)
	if (updates.length === 0) return false
	for (const [original, value] of updates) await replaceDocument(original, value)
	return true
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const [baseDirectory, binaryPath, option] = process.argv.slice(2)
	if (!baseDirectory || !binaryPath)
		throw new Error('Pass the T3 base directory and OpenCode bridge path')
	if (option !== undefined && option !== '--no-opencode')
		throw new Error('Unknown T3 settings option')
	await configureT3(baseDirectory, binaryPath, { manageOpenCode: option !== '--no-opencode' })
}
