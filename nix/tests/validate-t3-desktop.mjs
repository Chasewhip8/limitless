import assert from 'node:assert/strict'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Run with Node: <original main.cjs> <patched main.cjs> <private opener directory>.
// Executes T3's own PATH merge and publication code from the pinned bundle.
const [originalFile, patchedFile, opener] = process.argv.slice(2)
assert(originalFile && patchedFile && opener, 'Pass <original> <patched> <opener-directory>')

const publishStart = 'fn("desktop.shellEnvironment.publish")('
const hydrationCalls = [
	// Fresh login-shell discovery, then its publication.
	'mergePaths(config.platform, [trimNonEmpty(shellEnvironment.PATH).pipe(orElse$2(() => launchctlPath)), readEnvPath(config.env)])',
	'yield* publish$1(patch, prepared)',
	// Cache restoration, then its publication.
	'mergePaths(environment.platform, [some(cachedPath), readEnvPath(inherited)])',
	'yield* publish$1(Object.fromEntries(Object.keys(ShellEnvironmentPatch.fields).map((name) => [name, baseline[name] ?? null])))',
	// The only write of a hydrated environment into Electron's process environment.
	'applyShellEnvironment(env, patch, environment.platform)',
]

function only(source, text) {
	assert.equal(source.split(text).length, 2, `Expected exactly one ${text}`)
	return source.indexOf(text)
}

function section(source, start, end) {
	const from = only(source, start)
	const to = source.indexOf(end, from)
	assert(to > from, `Missing end of ${start}`)
	return source.slice(from, to + end.length)
}

function load(file) {
	const source = readFileSync(file, 'utf8')
	for (const call of hydrationCalls) only(source, call)
	const publishFrom = only(source, publishStart) + publishStart.length
	const publish = source.slice(publishFrom, source.indexOf('\n\t})', publishFrom) + '\n\t}'.length)
	const helpers = [
		section(source, 'function setWindowsPath(env, value) {', '\n}'),
		section(source, 'function applyShellEnvironment(env, patch, platform) {', '\n}'),
		section(source, 'const pathDelimiter = ', ';\n'),
		section(source, 'const pathComparisonKey = ', 'none$1();\n};'),
	].join('\n')
	const create = new Function(
		'env',
		'environment',
		`const isNone = (option) => option._tag === "None";
		const some = (value) => ({ _tag: "Some", value });
		const none$1 = () => ({ _tag: "None" });
		const set$2 = () => [];
		const publish = () => [];
		const latest = undefined;
		const changes = undefined;
		${helpers}
		return { mergePaths, some, publish: ${publish} };`,
	)
	return (env) => create(env, { platform: 'linux' })
}

function executable(directory) {
	writeFileSync(join(directory, 'xdg-open'), '#!/bin/sh\n', { mode: 0o755 })
	return directory
}

function resolve(path) {
	for (const directory of path.split(':')) {
		try {
			accessSync(join(directory, 'xdg-open'), constants.X_OK)
			return directory
		} catch {}
	}
}

const root = mkdtempSync(join(tmpdir(), 'limitless-t3-desktop-'))
try {
	const sandbox = executable(mkdtempSync(join(root, 'sandbox-')))
	const login = executable(mkdtempSync(join(root, 'login-')))
	const inheritedPath = `${opener}:${sandbox}`
	const discovered = {
		fresh: `${login}:${root}/missing`,
		cache: login,
	}

	function hydrate(bundle, source) {
		const env = { PATH: inheritedPath }
		const { mergePaths, some, publish } = bundle(env)
		const merged = mergePaths('linux', [some(discovered[source]), some(env.PATH)])
		const run = publish({ PATH: merged.value, SSH_AUTH_SOCK: null })
		while (!run.next().done) {}
		return env.PATH
	}

	const original = load(originalFile)
	const patched = load(patchedFile)
	for (const source of Object.keys(discovered)) {
		assert.equal(
			resolve(hydrate(original, source)),
			login,
			`Upstream ${source} hydration no longer prefers login-shell openers; recheck the patch`,
		)
		const path = hydrate(patched, source)
		assert.equal(resolve(path), opener, `${source} hydration bypassed the private opener`)
		assert.deepEqual(
			path.split(':').filter((entry) => entry !== opener),
			hydrate(original, source)
				.split(':')
				.filter((entry) => entry !== opener),
			`${source} hydration must keep T3's other PATH entries in order`,
		)
		assert.equal(path.split(':')[0], opener)
		assert.equal(path.split(':').filter((entry) => entry === opener).length, 1)
	}
	console.log('T3 desktop keeps the private opener first after fresh and cached hydration')
} finally {
	rmSync(root, { recursive: true, force: true })
}
