import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { Service } from '@opencode/client/service'
import { startT3Bridge } from './bridge'

export { startT3Bridge } from './bridge'

async function run() {
	const [command, ...args] = process.argv.slice(2)
	if (command === '--version' || command === '-v') {
		const executable = process.env.LIMITLESS_OPENCODE_BIN
		if (!executable) throw new Error('Use the packaged opencode-t3 launcher')
		const child = spawn(executable, ['--version'], { stdio: 'inherit' })
		process.exitCode = await new Promise<number>((resolve, reject) => {
			child.once('error', reject)
			child.once('exit', (code) => resolve(code ?? 1))
		})
		return
	}
	if (command === '--help' || command === '-h') {
		console.log(
			'opencode-t3: T3 launcher for the existing OpenCode service. Set it as T3’s OpenCode Binary path and leave Server URL blank.',
		)
		return
	}
	if (command !== 'serve')
		throw new Error(
			'opencode-t3 supports T3’s version and serve requests; use opencode for other commands',
		)
	const { values } = parseArgs({
		args,
		options: { hostname: { type: 'string' }, port: { type: 'string' } },
		strict: true,
	})
	const port = values.port === undefined ? 0 : Number(values.port)
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid bridge port')
	const password = process.env.OPENCODE_PASSWORD
	if (!password) throw new Error('T3 must supply OPENCODE_PASSWORD when launching this adapter')
	const backend = async () => {
		// Discovery never starts, replaces, or stops the system-managed server.
		const endpoint = await Service.discover()
		if (!endpoint)
			throw new Error('The managed OpenCode service is unavailable; start it before using T3')
		const headers = Service.headers({
			url: endpoint.url,
			...(endpoint.auth === undefined ? {} : { auth: endpoint.auth }),
		})
		if (headers === undefined)
			throw new Error('The managed OpenCode service must provide authentication')
		return { url: new URL(endpoint.url), headers }
	}
	await backend()
	const bridge = await startT3Bridge({
		backend,
		password,
		port,
		...(values.hostname === undefined ? {} : { hostname: values.hostname }),
	})
	console.log(`opencode server listening on ${bridge.url}`)
	const shutdown = () => {
		void bridge.close().then(
			() => process.exit(0),
			() => {
				console.error(
					'The T3 bridge did not shut down cleanly; the managed service was not stopped',
				)
				process.exit(1)
			},
		)
	}
	process.once('SIGTERM', shutdown)
	process.once('SIGINT', shutdown)
}

// Bun's node-target bundler rewrites import.meta.main into an unsafe CommonJS check.
if (
	process.argv[1] !== undefined &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	void run().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : 'Unable to start the T3 bridge')
		process.exitCode = 1
	})
}
