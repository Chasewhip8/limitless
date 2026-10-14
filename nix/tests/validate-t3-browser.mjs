import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const [packagePath, executablePath, system, strace, loader, version, mode] = process.argv.slice(2)
assert(packagePath && executablePath && system && strace && loader && version)
assert(mode === undefined || mode === '--loader-only', 'Unknown browser test mode')
const run = promisify(execFile)
const temporary = tmpdir()
await mkdir(temporary, { recursive: true })
const directory = await mkdtemp(join(temporary, 'limitless-t3-browser-'))
const nativeLibraryVariable = `NIX_LD_LIBRARY_PATH_${system.replaceAll('-', '_')}`
const loaderVariable = `NIX_LD_${system.replaceAll('-', '_')}`
const otherLibraryVariable = `NIX_LD_LIBRARY_PATH_${system === 'x86_64-linux' ? 'aarch64_linux' : 'x86_64_linux'}`
const environment = {
	PATH: process.env.PATH,
	HOME: join(directory, 'home'),
	TMPDIR: directory,
	XDG_RUNTIME_DIR: join(directory, 'runtime'),
}
for (const name of ['CONFIG', 'DATA', 'CACHE', 'STATE']) {
	environment[`XDG_${name}_HOME`] = join(directory, name.toLowerCase())
}
for (const path of Object.values(environment).filter((value) => value?.startsWith(directory))) {
	await mkdir(path, { recursive: true, mode: 0o700 })
}

async function wrapperEnvironment(label, input) {
	const trace = join(directory, `${label}.trace`)
	await run(
		strace,
		[
			'-qq',
			'-f',
			'-v',
			'-s',
			'65536',
			'-e',
			'trace=execve',
			'-o',
			trace,
			`${packagePath}/bin/t3`,
			'--version',
		],
		{ cwd: directory, env: { ...environment, ...input }, timeout: 30000 },
	)
	const target = `${packagePath}/lib/t3/t3`
	const line = (await readFile(trace, 'utf8'))
		.split('\n')
		.find((value) => value.includes(`execve(${JSON.stringify(target)}, `))
	assert(line, 'The wrapper must execute the real T3 binary in its sibling resource directory')
	const encoded = /, \[.*?\], (\[.*\])\)\s+= 0$/.exec(line)?.[1]
	assert(encoded, `Cannot read the wrapped process environment: ${line}`)
	return Object.fromEntries(
		JSON.parse(encoded).map((entry) => {
			const separator = entry.indexOf('=')
			return [entry.slice(0, separator), entry.slice(separator + 1)]
		}),
	)
}

async function checkWrapper() {
	const empty = await wrapperEnvironment('empty-generic-baseline', { NIX_LD_LIBRARY_PATH: '' })
	const libraries = empty.NIX_LD_LIBRARY_PATH
	assert(libraries, 'The package must supply browser libraries')
	assert(libraries.split(':').every((path) => path.startsWith('/nix/store/')))
	const cases = [
		['default', {}, '/run/current-system/sw/share/nix-ld/lib'],
		['generic', { NIX_LD_LIBRARY_PATH: '/fixture/generic' }, '/fixture/generic'],
		[
			'native',
			{ NIX_LD_LIBRARY_PATH: '/fixture/generic', [nativeLibraryVariable]: '/fixture/native' },
			'/fixture/native',
		],
		['empty-generic', { NIX_LD_LIBRARY_PATH: '' }, ''],
		[
			'empty-native-with-generic',
			{ NIX_LD_LIBRARY_PATH: '/fixture/generic', [nativeLibraryVariable]: '' },
			'',
		],
		['idempotent-generic', { NIX_LD_LIBRARY_PATH: libraries }, ''],
		['idempotent-native', { [nativeLibraryVariable]: libraries }, ''],
	]
	for (const [label, paths, inherited] of cases) {
		const input = {
			...paths,
			...(label === 'native'
				? {
						NIX_LD: '/fixture/operator-loader',
						[loaderVariable]: '/fixture/operator-native-loader',
						[otherLibraryVariable]: '/fixture/other-architecture',
					}
				: {}),
		}
		const result = await wrapperEnvironment(label, input)
		const libraryVariable = Object.hasOwn(input, nativeLibraryVariable)
			? nativeLibraryVariable
			: 'NIX_LD_LIBRARY_PATH'
		assert.equal(result[libraryVariable], `${libraries}${inherited ? `:${inherited}` : ''}`, label)
		for (const key of [
			'NIX_LD_LIBRARY_PATH',
			nativeLibraryVariable,
			'NIX_LD',
			loaderVariable,
			otherLibraryVariable,
		]) {
			if (key === libraryVariable) continue
			assert.equal(result[key], input[key], `${label}: ${key} must be preserved`)
		}
		assert.equal(
			result.LD_LIBRARY_PATH,
			undefined,
			'Do not inject browser libraries into Nix-patched programs',
		)
		assert.equal(result.T3CODE_SERVER_BROWSER_SANDBOX, undefined, 'Do not disable the sandbox')
	}
	return { ...environment, NIX_LD_LIBRARY_PATH: libraries }
}

const html =
	'<!doctype html><meta charset="utf-8"><title>T3 browser smoke</title><h1 id="result">Sandboxed browser works</h1>'
const url = `data:text/html,${encodeURIComponent(html)}`
function checkPng(png) {
	assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
	assert(png.length > 100)
}

async function checkPlaywright(env) {
	const require = createRequire(`${packagePath}/lib/t3/package.json`)
	const { chromium } = require('playwright-core')
	const options = {
		executablePath,
		env,
		args: [
			'--disable-gpu',
			'--force-device-scale-factor=2',
			'--disable-blink-features=AutomationControlled',
		],
		ignoreDefaultArgs: ['--enable-automation'],
		headless: true,
		chromiumSandbox: true,
	}
	const browser = await chromium.launch(options)
	try {
		const context = await browser.newContext({
			viewport: { width: 1280, height: 800 },
			deviceScaleFactor: 2,
		})
		const page = await context.newPage()
		await page.goto(url)
		assert.equal(await page.locator('#result').textContent(), 'Sandboxed browser works')
		checkPng(await page.screenshot())
	} finally {
		await browser.close()
	}
	const context = await chromium.launchPersistentContext(
		join(directory, 'persistent-profile'),
		options,
	)
	try {
		const page = await context.newPage()
		await page.goto(url)
		assert.equal(await page.title(), 'T3 browser smoke')
		checkPng(await page.screenshot())
	} finally {
		await context.close()
	}
}

async function checkHtmlLaunch(env) {
	// Exercise the HTML renderer's direct browser startup and network isolation
	// without maintaining a separate CDP client in this dependency smoke test.
	const screenshot = join(directory, 'html.png')
	const result = await run(
		executablePath,
		[
			'--headless=new',
			'--dump-dom',
			`--screenshot=${screenshot}`,
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-gpu',
			'--hide-scrollbars',
			'--mute-audio',
			'--block-new-web-contents',
			'--proxy-server=socks5://127.0.0.1:9',
			'--proxy-bypass-list=<-loopback>',
			'--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
			`--user-data-dir=${join(directory, 'html-profile')}`,
			url,
		],
		{ env, timeout: 30000, killSignal: 'SIGKILL' },
	)
	assert(result.stdout.includes('<h1 id="result">Sandboxed browser works</h1>'))
	checkPng(await readFile(screenshot))
}

try {
	const env = await checkWrapper()
	// Calling the loader explicitly checks real dependency resolution even in a
	// Nix build sandbox without the NixOS host's absolute ELF interpreter symlink.
	const result = await run(
		loader,
		['--library-path', env.NIX_LD_LIBRARY_PATH, executablePath, '--version'],
		{ env, timeout: 30000 },
	)
	assert(result.stdout.includes(version), result.stdout)
	console.log(`PASS ${system}: wrapper environment and Chrome ${version} loader dependencies`)
	if (mode !== '--loader-only') {
		await checkPlaywright(env)
		await checkHtmlLaunch(env)
		console.log(
			'PASS: sandboxed shared/persistent previews and HTML rendering; isolated profiles, no external sites',
		)
	}
} finally {
	await rm(directory, { recursive: true, force: true })
}
