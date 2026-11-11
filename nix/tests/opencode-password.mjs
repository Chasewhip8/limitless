import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const [executable] = process.argv.slice(2)
assert(executable, 'Pass the packaged native OpenCode executable')
assert(process.getuid?.() !== 0, 'Run the unreadable-file fixture as an unprivileged user')
process.umask(0o077)

const protectedValues = new Set()
const output = []
const homes = []
const children = []

function protect(value) {
	if (value) {
		protectedValues.add(value)
		protectedValues.add(Buffer.from(`opencode:${value}`).toString('base64'))
	}
	return value
}

function noLeaks(text) {
	for (const value of protectedValues)
		assert(!text.includes(value), 'A synthetic credential leaked to command or service output')
}

async function home(name) {
	const root = await mkdtemp(join(process.env.TMPDIR ?? '/tmp/opencode', `password-${name}-`))
	for (const directory of ['home', 'config', 'data', 'state', 'cache', 'runtime', 'tmp'])
		await mkdir(join(root, directory), { mode: 0o700 })
	const result = {
		root,
		config: join(root, 'config', 'opencode', 'service.json'),
		registration: join(root, 'state', 'opencode', 'service.json'),
		env: {
			PATH: process.env.PATH ?? '',
			HOME: join(root, 'home'),
			OPENCODE_TEST_HOME: join(root, 'home'),
			XDG_CONFIG_HOME: join(root, 'config'),
			XDG_DATA_HOME: join(root, 'data'),
			XDG_STATE_HOME: join(root, 'state'),
			XDG_CACHE_HOME: join(root, 'cache'),
			XDG_RUNTIME_DIR: join(root, 'runtime'),
			TMPDIR: join(root, 'tmp'),
			OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: ['-opencode.browser'] }),
			OPENCODE_CONFIG_PROJECT_DISABLE: 'true',
			OPENCODE_DISABLE_CLAUDE_CODE: 'true',
			OPENCODE_DISABLE_MODELS_FETCH: 'true',
			OPENCODE_DISABLE_FILEWATCHER: 'true',
			OPENCODE_CLI_CONFIG_CONTENT: '{}',
			NO_COLOR: '1',
			TERM: 'dumb',
		},
	}
	homes.push(result)
	return result
}

function launch(fixture, args, timeout = 60_000) {
	const child = spawn(executable, args, {
		env: fixture.env,
		cwd: fixture.env.HOME,
		stdio: ['ignore', 'pipe', 'pipe'],
		...(timeout ? { timeout, killSignal: 'SIGKILL' } : {}),
	})
	let stdout = ''
	let stderr = ''
	child.stdout.on('data', (chunk) => {
		stdout += chunk
	})
	child.stderr.on('data', (chunk) => {
		stderr += chunk
	})
	const exited = new Promise((resolve, reject) => {
		child.once('error', reject)
		child.once('close', (code, signal) => {
			output.push(stdout, stderr)
			resolve({ code, signal, stdout, stderr })
		})
	})
	const result = { child, exited }
	children.push(result)
	return result
}

async function cli(fixture, args, label, { fail = false, silent = false } = {}) {
	const result = await launch(fixture, args).exited
	noLeaks(result.stdout + result.stderr)
	assert(result.signal === null, `${label}: command timed out or was signalled`)
	assert(fail ? result.code !== 0 : result.code === 0, `${label}: unexpected exit status`)
	if (silent) assert(!result.stdout && !result.stderr, `${label}: successful import must be silent`)
	return result
}

async function exists(path) {
	return lstat(path).then(
		() => true,
		(error) => {
			if (error.code === 'ENOENT') return false
			throw error
		},
	)
}

async function snapshot(fixture) {
	const bytes = await readFile(fixture.config)
	const info = await stat(fixture.config, { bigint: true })
	assert((info.mode & 0o777n) === 0o600n, 'Native service configuration must be mode 0600')
	return { bytes, ino: info.ino, mtime: info.mtimeNs }
}

async function unchanged(fixture, before, pid) {
	const after = await snapshot(fixture)
	assert(
		before.bytes.equals(after.bytes),
		'Refusal or unchanged import rewrote service configuration',
	)
	assert(
		before.ino === after.ino && before.mtime === after.mtime,
		'Refusal or unchanged import replaced/touched the native configuration',
	)
	if (pid !== undefined) {
		const registration = JSON.parse(await readFile(fixture.registration, 'utf8'))
		assert(registration.pid === pid, 'Refusal or unchanged import replaced the incumbent')
		assert(
			(await status(registration.url, registration.password)) === 200,
			'Refusal or unchanged import stopped the incumbent',
		)
	}
}

async function availablePort() {
	const server = createServer()
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address()
	await new Promise((resolve) => server.close(resolve))
	return port
}

async function status(url, password, path = '/api/info', options = {}) {
	const response = await fetch(new URL(path, url), {
		...options,
		headers:
			password === undefined
				? {}
				: {
						authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
					},
		signal: AbortSignal.timeout(2000),
	})
	await response.arrayBuffer()
	return response.status
}

async function registered(fixture, password) {
	const deadline = Date.now() + 45_000
	while (Date.now() < deadline) {
		const registration = await readFile(fixture.registration, 'utf8')
			.then(JSON.parse)
			.catch(() => undefined)
		if (registration && (await status(registration.url, password).catch(() => 0)) === 200) {
			assert(
				registration.password === password,
				'Managed registration did not use the imported credential',
			)
			assert(registration.version === '2.2.7', 'Recheck the password contract on upstream upgrades')
			assert(
				((await stat(fixture.registration)).mode & 0o777) === 0o600,
				'Native service registration must be private',
			)
			return registration
		}
		await delay(50)
	}
	throw new Error('Isolated managed service did not become ready')
}

async function pair(url, password) {
	const response = await fetch(new URL('/api/pair', url), {
		method: 'POST',
		headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
		signal: AbortSignal.timeout(5000),
	})
	assert(response.status === 200, 'Native pairing code request failed')
	const { code } = await response.json()
	protect(code)
	const connection = await fetch(new URL(`/auth/connect/${code}`, url), {
		headers: { accept: 'application/json' },
		signal: AbortSignal.timeout(5000),
	})
	assert(connection.status === 200, 'Native pairing code exchange failed')
	const { token } = await connection.json()
	assert(
		typeof token === 'string' && token.length > 0,
		'Native pairing did not issue a session token',
	)
	return protect(token)
}

async function importFile(fixture, file, label) {
	await cli(fixture, ['service', 'set', 'password', '--file', file], label, { silent: true })
}

async function assertLogs(fixture) {
	const directory = join(fixture.root, 'data', 'opencode', 'log')
	if (!(await exists(directory))) return
	for (const file of await readdir(directory, { recursive: true })) {
		const path = join(directory, file)
		if ((await stat(path)).isFile()) noLeaks(await readFile(path, 'utf8'))
	}
}

try {
	const fixture = await home('managed')
	const fifo = join(fixture.root, 'password-fifo')
	const makeFifo = spawn('mkfifo', [fifo], { stdio: 'ignore' })
	assert(
		(await new Promise((resolve) => makeFifo.once('close', resolve))) === 0,
		'Could not create isolated FIFO',
	)
	const help = await cli(fixture, ['service', 'set', '--help'], 'password-file help')
	for (const word of ['--file', '4096', 'UTF-8', 'LF', 'CRLF', 'Spaces', 'no-op', 'silent', 'stop'])
		assert(
			help.stdout.includes(word),
			'CLI help omitted a password-file format/lifecycle guarantee',
		)
	const shapes = [
		['service', 'set', 'password'],
		['service', 'set', 'env', 'FIXTURE_EMPTY'],
		['service', 'set', 'hostname'],
		['service', 'set', 'password', '--file'],
		['service', 'set', 'password', 'extra', '--file', fifo],
		['service', 'set', 'password', 'extra', 'extra', '--file', fifo],
		['service', 'set', 'env', 'FIXTURE_EMPTY', '', '--file', fifo],
		['service', 'set', 'hostname', '--file', fifo],
		['service', 'set', 'password', 'extra', 'extra'],
	]
	for (const args of shapes) {
		const result = await cli(fixture, args, 'reject ambiguous/missing arguments', { fail: true })
		assert(
			!result.stderr.includes('Invalid password file'),
			'Argument validation must precede file operations',
		)
		assert(!(await exists(fixture.config)), 'Malformed arguments created a service configuration')
		assert(!(await exists(fixture.registration)), 'Malformed arguments started a service')
	}

	const port = await availablePort()
	for (const [key, ...values] of [
		['env', 'FIXTURE_EMPTY', ''],
		['env', 'FIXTURE_KEEP', ' leading and trailing spaces '],
		['cors', 'https://fixture.example,https://second.example'],
		['disabled', 'true'],
		['hostname', '127.0.0.1'],
		['port', String(port)],
	])
		await cli(fixture, ['service', 'set', key, ...values], 'legacy native setting compatibility')
	const initial = JSON.parse(await readFile(fixture.config, 'utf8'))
	assert(initial.env.FIXTURE_EMPTY === '', 'Optional value parsing lost an empty legacy env value')
	assert(
		initial.env.FIXTURE_KEEP === ' leading and trailing spaces ',
		'Legacy env value was trimmed',
	)
	const candidate = join(fixture.root, 'candidate')
	for (const [name, contents, expected] of [
		['plain', 'synthetic-format-plain', 'synthetic-format-plain'],
		['LF', 'synthetic-format-lf\n', 'synthetic-format-lf'],
		['CRLF', 'synthetic-format-crlf\r\n', 'synthetic-format-crlf'],
		['spaces', '  synthetic-spaced-password  \n', '  synthetic-spaced-password  '],
		['UTF-8', 'synthetic-unicode-é-密碼\n', 'synthetic-unicode-é-密碼'],
		['BOM', '\ufeffsynthetic-bom-password', '\ufeffsynthetic-bom-password'],
		['4096 bytes', 'a'.repeat(4096), 'a'.repeat(4096)],
		['4096 bytes with CRLF', `${'b'.repeat(4094)}\r\n`, 'b'.repeat(4094)],
		['4096 multibyte bytes', 'é'.repeat(2048), 'é'.repeat(2048)],
	]) {
		protect(expected)
		await writeFile(candidate, contents, { mode: 0o600 })
		await importFile(fixture, candidate, `accept ${name}`)
		assert(
			JSON.parse(await readFile(fixture.config, 'utf8')).password === expected,
			'Password-file import altered accepted bytes',
		)
		await snapshot(fixture)
		assert(!(await exists(fixture.registration)), 'Password-file import auto-started a service')
	}

	const oldPassword = protect('synthetic-managed-incumbent-password')
	const newPassword = protect('synthetic-managed-rotated-password')
	await writeFile(candidate, oldPassword)
	await importFile(fixture, candidate, 'install incumbent synthetic password')
	const native = launch(fixture, ['serve', '--service'], 0)
	const beforeRegistration = await registered(fixture, oldPassword)
	const before = await snapshot(fixture)
	assert(
		(await status(beforeRegistration.url)) === 401,
		'Managed service accepted unauthenticated access',
	)
	assert(
		(await status(beforeRegistration.url, protect('synthetic-wrong-password'))) === 401,
		'Managed service accepted a wrong password',
	)
	const oldPairToken = await pair(beforeRegistration.url, oldPassword)
	assert(
		(await status(beforeRegistration.url, oldPairToken)) === 200,
		'Native paired token did not authenticate',
	)
	for (const ending of ['', '\n', '\r\n']) {
		await writeFile(candidate, oldPassword + ending)
		await importFile(fixture, candidate, 'unchanged import')
		await unchanged(fixture, before, beforeRegistration.pid)
	}

	const invalidMarker = protect('synthetic-invalid-file-marker')
	const unreadable = join(fixture.root, 'unreadable')
	await writeFile(unreadable, invalidMarker, { mode: 0o000 })
	await chmod(unreadable, 0o000)
	const broken = join(fixture.root, 'broken-link')
	await symlink(join(fixture.root, 'absent'), broken)
	for (const [name, contents] of [
		['empty', ''],
		['LF only', '\n'],
		['CRLF only', '\r\n'],
		['two final newlines', `${invalidMarker}\n\n`],
		['two lines', `${invalidMarker}\nsecond`],
		['embedded CR', `${invalidMarker}\rsecond`],
		['bare final CR', `${invalidMarker}\r`],
		['NUL', `${invalidMarker}\0`],
		['tab', `${invalidMarker}\t`],
		['escape', `${invalidMarker}\x1b`],
		['DEL', `${invalidMarker}\x7f`],
		['C1 control', `${invalidMarker}\u0085`],
		['Unicode line separator', `${invalidMarker}\u2028second`],
		['Unicode paragraph separator', `${invalidMarker}\u2029second`],
		['oversize', `${invalidMarker}${'c'.repeat(4097)}`],
		['4097 byte boundary', 'd'.repeat(4097)],
		['4097 including LF', `${'e'.repeat(4096)}\n`],
		['invalid UTF-8', Buffer.concat([Buffer.from(invalidMarker), Buffer.from([0xc3, 0x28])])],
		['truncated UTF-8', Buffer.concat([Buffer.from(invalidMarker), Buffer.from([0xe2, 0x82])])],
	]) {
		await writeFile(candidate, contents)
		const result = await cli(
			fixture,
			['service', 'set', 'password', '--file', candidate],
			`reject ${name}`,
			{ fail: true },
		)
		assert(
			result.stderr.includes('Invalid password file'),
			'File refusal did not use a generic error',
		)
		assert(!result.stdout, 'A refused import wrote stdout')
		await unchanged(fixture, before, beforeRegistration.pid)
	}
	for (const file of [
		join(fixture.root, 'missing'),
		unreadable,
		broken,
		fixture.root,
		fifo,
		'/dev/null',
		'/dev/zero',
	]) {
		const result = await cli(
			fixture,
			['service', 'set', 'password', '--file', file],
			'reject missing/unreadable/special files without blocking',
			{ fail: true },
		)
		assert(
			result.stderr.includes('Invalid password file'),
			'File access failure exposed an underlying cause',
		)
		await unchanged(fixture, before, beforeRegistration.pid)
	}
	for (const args of shapes) {
		await cli(fixture, args, 'invalid arguments preserve incumbent', { fail: true })
		await unchanged(fixture, before, beforeRegistration.pid)
	}

	const generation = join(fixture.root, 'secret-generation')
	await mkdir(generation)
	await writeFile(join(generation, 'password'), `${newPassword}\r\n`, { mode: 0o600 })
	const runtimeFile = join(fixture.root, 'runtime', 'password')
	await symlink(join(generation, 'password'), runtimeFile)
	await importFile(fixture, runtimeFile, 'rotate through runtime secret symlink')
	await native.exited
	assert(
		native.child.exitCode !== null || native.child.signalCode !== null,
		'Changed import left incumbent running',
	)
	assert(
		!(await exists(fixture.registration)),
		'Changed import did not remove the stopped registration',
	)
	const rotated = JSON.parse(await readFile(fixture.config, 'utf8'))
	assert(rotated.password === newPassword, 'Changed import did not persist the new credential')
	const { password: _old, ...oldSettings } = JSON.parse(before.bytes)
	const { password: _new, ...newSettings } = rotated
	assert(
		JSON.stringify(oldSettings) === JSON.stringify(newSettings),
		'Password rotation lost unrelated cors/env/disabled/bind settings',
	)
	await snapshot(fixture)

	await cli(fixture, ['service', 'unset', 'disabled'], 'enable managed discovery')
	const restarted = launch(fixture, ['serve', '--service'], 0)
	const afterRegistration = await registered(fixture, newPassword)
	assert(
		afterRegistration.pid !== beforeRegistration.pid,
		'Managed restart reused the stopped process',
	)
	assert(
		(await status(afterRegistration.url, oldPassword)) === 401,
		'Rotation did not revoke the old password',
	)
	assert(
		(await status(afterRegistration.url, oldPairToken)) === 401,
		'Rotation did not revoke the old paired session',
	)
	assert(
		(await status(afterRegistration.url, newPassword)) === 200,
		'Managed restart rejected the imported password',
	)
	const newPairToken = await pair(afterRegistration.url, newPassword)
	assert(
		(await status(afterRegistration.url, newPairToken)) === 200,
		'New pairing token was not accepted',
	)
	const discovery = await cli(fixture, ['api', 'get', '/api/info'], 'native local discovery')
	assert(
		JSON.parse(discovery.stdout).pid === afterRegistration.pid,
		'Local discovery failed to reuse the imported identity',
	)
	await cli(fixture, ['service', 'stop'], 'stop restarted managed service')
	await restarted.exited

	const automatic = await home('autostart')
	await cli(
		automatic,
		['service', 'set', 'port', String(await availablePort())],
		'isolated autostart bind',
	)
	const autoPassword = protect('synthetic-independent-autostart-password')
	const autoFile = join(automatic.root, 'password')
	await writeFile(autoFile, `${autoPassword}\n`, { mode: 0o600 })
	await importFile(automatic, autoFile, 'import before independent autostart')
	assert(!(await exists(automatic.registration)), 'Independent import auto-started a service')
	const autoBefore = await snapshot(automatic)
	const first = await cli(automatic, ['api', 'get', '/api/info'], 'independent native autostart')
	const autoRegistration = await registered(automatic, autoPassword)
	assert(
		JSON.parse(first.stdout).pid === autoRegistration.pid,
		'Autostart did not use isolated registration',
	)
	const second = await cli(automatic, ['api', 'get', '/api/info'], 'independent native rediscovery')
	assert(
		JSON.parse(second.stdout).pid === autoRegistration.pid,
		'Rediscovery replaced the autostarted service',
	)
	await unchanged(automatic, autoBefore, autoRegistration.pid)
	assert(
		(await status(autoRegistration.url, oldPassword)) === 401,
		'Autostart accepted an unrelated identity',
	)
	await cli(automatic, ['service', 'stop'], 'stop independently autostarted service')
	assert(!(await exists(automatic.registration)), 'Autostart cleanup left a service registration')
	console.log(
		'Native password-file checks passed: arguments, formats, refusals, no-op, rotation, pairing revocation, discovery, isolated autostart.',
	)
} finally {
	for (const fixture of homes) {
		if (await exists(fixture.registration)) {
			await cli(fixture, ['service', 'stop'], 'fixture cleanup', { fail: false })
		}
	}
	for (const { child, exited } of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
		await exited
	}
	for (const text of output) noLeaks(text)
	for (const fixture of homes) await assertLogs(fixture)
}
