import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function prepareService(opencode, hostname, port, environment = process.env) {
	function service(...args) {
		const result = spawnSync(opencode, ['service', ...args], {
			env: environment,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'inherit'],
		})
		if (result.error) throw result.error
		if (result.status !== 0) {
			throw new Error(`OpenCode service ${args[0]} failed (${result.signal ?? result.status})`)
		}
		return result.stdout.trimEnd()
	}

	// Native client startup applies this private environment; foreground serve does not.
	const configuredEnvironment = parseEnvironment(service('get', 'env'))
	for (const [key, value] of [
		['hostname', hostname],
		['port', String(port)],
	]) {
		if (service('get', key) !== value) service('set', key, value)
	}
	// A compatible incumbent makes serve exit successfully instead of being supervised.
	service('stop')
	return { ...environment, ...configuredEnvironment }
}

function parseEnvironment(text) {
	let value
	try {
		value = JSON.parse(text)
	} catch {
		// JSON parser errors can include fragments of private environment values.
		throw new Error('OpenCode returned invalid service environment JSON')
	}
	if (
		value === null ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		!Object.entries(value).every(
			([key, entry]) =>
				key.length > 0 &&
				!key.includes('=') &&
				!key.includes('\0') &&
				typeof entry === 'string' &&
				!entry.includes('\0'),
		)
	) {
		throw new Error('OpenCode returned an invalid service environment')
	}
	return value
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [opencode, hostname, port] = process.argv.slice(2)
	if (!opencode || !hostname || !port) {
		throw new Error('Usage: opencode-service.mjs <opencode> <hostname> <port>')
	}
	const environment = prepareService(opencode, hostname, port)
	process.execve(
		opencode,
		[opencode, 'serve', '--service', '--hostname', hostname, '--port', port],
		environment,
	)
}
