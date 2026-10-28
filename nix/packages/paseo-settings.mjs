import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { uptime } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

// Paseo's UI owns this mutable file too; preserve unmanaged keys and its password hash.

function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function objectField(object, key, path) {
	const value = object[key]
	if (value === undefined) return {}
	if (!isObject(value)) throw new Error(`Paseo config ${path}.${key} must be a JSON object`)
	return value
}

async function document(path) {
	try {
		const status = await lstat(path)
		if (!status.isFile()) {
			throw new Error(`Refusing to replace a non-regular Paseo config file: ${path}`)
		}
		const text = await readFile(path, 'utf8')
		const value = parseConfig(text, path)
		return { path, value, mode: status.mode & 0o777, text }
	} catch (error) {
		if (error.code === 'ENOENT') return { path, value: {}, mode: 0o600, text: undefined }
		throw error
	}
}

function parseConfig(text, path) {
	let value
	try {
		// Paseo accepts a leading byte-order mark.
		value = JSON.parse(text.replace(/^\uFEFF/, ''))
	} catch {
		throw new Error(`Paseo config must be valid plain JSON before provisioning: ${path}`)
	}
	if (!isObject(value)) throw new Error(`Paseo config must contain a JSON object: ${path}`)
	return value
}

function currentBootId() {
	try {
		return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined
	} catch {
		return undefined
	}
}

// Mirrors Paseo's own lock check (pid-lock.ts): a lock written during another
// boot is abandoned however alive its reused PID looks.
export function writtenDuringThisBoot(lock, bootId = currentBootId(), now = Date.now()) {
	if (typeof lock.bootId === 'string' && lock.bootId !== '' && bootId !== undefined)
		return lock.bootId === bootId
	const started = Date.parse(lock.startedAt)
	if (Number.isNaN(started)) return true
	return started >= now - uptime() * 1000 - 5000
}

async function readDaemonLock(path) {
	// Paseo creates before writing and truncates on updates; pid-lock.ts retries ten reads.
	for (let attempt = 0; attempt < 10; attempt++) {
		const text = await readFile(path, 'utf8').catch((error) => {
			if (error.code === 'ENOENT') return undefined
			throw error
		})
		if (text === undefined) return undefined
		if (text !== '') {
			try {
				return JSON.parse(text)
			} catch {
				if (attempt === 9) throw new Error(`Cannot verify whether Paseo is stopped: ${path}`)
			}
		}
		if (attempt < 9) await delay(50)
	}
	return undefined
}

// Atomic replacement cannot lock out the daemon's own writer, even when settings already match.
async function requireStopped(path) {
	const lock = await readDaemonLock(path)
	if (lock === undefined) return
	if (!isObject(lock) || !Number.isSafeInteger(lock.pid) || lock.pid <= 0) {
		throw new Error(`Invalid Paseo daemon lock: ${path}`)
	}
	if (!writtenDuringThisBoot(lock)) return
	let probeDenied = false
	try {
		process.kill(lock.pid, 0)
	} catch (error) {
		if (error.code === 'ESRCH') return
		if (error.code !== 'EPERM') throw error
		probeDenied = true
	}
	throw new Error(
		`Paseo daemon lock ${path} refers to live PID ${lock.pid}${probeDenied ? ' (process probe denied: EPERM)' : ''}. ` +
			'Quit the Paseo desktop’s own daemon and stop any other Paseo daemon using this home before starting the managed service. ' +
			'If a crash left a reused PID, stop service retries and verify no Paseo daemon uses this home before moving only the stale lock aside.',
	)
}

async function replaceDocument(original, value) {
	const directory = dirname(original.path)
	await mkdir(directory, { recursive: true, mode: 0o700 })
	const temporary = join(directory, `.limitless-paseo-${randomUUID()}.tmp`)
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
		await chmod(temporary, original.mode)
		const current = await document(original.path)
		if (current.text !== original.text || current.mode !== original.mode) {
			throw new Error('Paseo config changed during provisioning; stop Paseo and try again')
		}
		await rename(temporary, original.path)
	} finally {
		await unlink(temporary).catch((error) => {
			if (error.code !== 'ENOENT') throw error
		})
	}
}

export function managedConfig(config, { listen, launcher, browserTools }) {
	const daemon = objectField(config, 'daemon', 'config')
	const agents = objectField(config, 'agents', 'config')
	const providers = objectField(agents, 'providers', 'agents')
	const opencode = objectField(providers, 'opencode', 'agents.providers')
	return {
		...config,
		version: 1,
		daemon: {
			...daemon,
			listen,
			relay: { ...objectField(daemon, 'relay', 'daemon'), enabled: false },
			mcp: { ...objectField(daemon, 'mcp', 'daemon'), enabled: true, injectIntoAgents: true },
			browserTools: { ...objectField(daemon, 'browserTools', 'daemon'), enabled: browserTools },
		},
		agents: {
			...agents,
			providers: {
				...providers,
				opencode: { ...opencode, enabled: true, command: [launcher] },
			},
		},
	}
}

export async function configurePaseo(home, settings) {
	if (!isAbsolute(home) || home !== home.trim()) {
		throw new Error('Paseo home must be absolute with no surrounding whitespace')
	}
	if (!isAbsolute(settings.launcher))
		throw new Error('The opencode-paseo launcher must be absolute')
	await requireStopped(join(home, 'paseo.pid'))
	const original = await document(join(home, 'config.json'))
	const value = managedConfig(original.value, settings)
	if (JSON.stringify(original.value) === JSON.stringify(value)) return false
	await replaceDocument(original, value)
	return true
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const [home, listen, launcher, browserTools] = process.argv.slice(2)
	if (!home || !listen || !launcher || !['true', 'false'].includes(browserTools))
		throw new Error(
			'Pass the Paseo home, listen address, opencode-paseo path, and true|false browser tools',
		)
	await configurePaseo(home, { listen, launcher, browserTools: browserTools === 'true' })
}
