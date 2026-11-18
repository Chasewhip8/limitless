import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

// Proves Limitless's GPT-6.2 backfill through packaged OpenCode's real provider and model assembly:
// catalog loading, ChatGPT token sharing, legacy Codex, API keys, account switches, and late config.
const [opencode, limitless, fixture] = process.argv.slice(2)
assert(
	opencode && limitless && fixture,
	'Pass the OpenCode executable, Limitless package, and catalog fixture',
)

const backfilled = ['gpt-6.2-astra', 'gpt-6.2-sol']
const root = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'openai-catalog-'))
const password = 'synthetic-openai-catalog-password'
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
const secrets = [password]
const output = []
const servers = []
const expires = Date.now() + 365 * 24 * 60 * 60 * 1000

function secret(name) {
	const value = `synthetic-${name}-${secrets.length}`
	secrets.push(value)
	return value
}

const credentials = {
	apiKey: () => ({ type: 'key', key: secret('api-key') }),
	tokenSharing: () => ({
		type: 'oauth',
		methodID: 'chatgpt-token-sharing',
		refresh: secret('token-sharing-refresh'),
		access: secret('token-sharing-access'),
		expires,
		metadata: { clientID: 'synthetic-client', scopes: ['chatgpt.tokens.use.direct'] },
	}),
	legacyCodex: () => ({
		type: 'oauth',
		methodID: 'chatgpt-browser',
		refresh: secret('codex-refresh'),
		access: secret('codex-access'),
		expires,
		metadata: { accountID: 'synthetic-account' },
	}),
}

const catalog = JSON.parse(await readFile(fixture, 'utf8'))
const withoutBackfilled = structuredClone(catalog)
for (const id of backfilled) delete withoutBackfilled.openai.models[id]
const newer = structuredClone(catalog)
Object.assign(newer.openai.models['gpt-6.2-astra'], {
	name: 'GPT-6.2 Astra Catalog',
	limit: { context: 400_000, input: 272_000, output: 64_000 },
})
const catalogs = { fresh: catalog, stale: withoutBackfilled, newer }

async function isolated(name) {
	const directory = join(root, name)
	for (const path of ['home', 'config', 'data', 'state', 'cache', 'run', 'tmp'])
		await mkdir(join(directory, path), { recursive: true })
	return {
		directory,
		home: join(directory, 'home'),
		env: {
			PATH: process.env.PATH ?? '',
			HOME: join(directory, 'home'),
			XDG_CONFIG_HOME: join(directory, 'config'),
			XDG_DATA_HOME: join(directory, 'data'),
			XDG_STATE_HOME: join(directory, 'state'),
			XDG_CACHE_HOME: join(directory, 'cache'),
			XDG_RUNTIME_DIR: join(directory, 'run'),
			TMPDIR: join(directory, 'tmp'),
			OPENCODE_CONFIG_PROJECT_DISABLE: '1',
			OPENCODE_DISABLE_MODELS_FETCH: '1',
			OPENCODE_DISABLE_FILEWATCHER: '1',
			OPENCODE_DISABLE_FFF: '1',
			OPENCODE_DISABLE_CLAUDE_CODE: '1',
		},
	}
}

async function start(name, { catalog: catalogName, limitlessOptions = {}, providers } = {}) {
	const { directory, home, env } = await isolated(name)
	const config = join(directory, 'opencode.json')
	await writeFile(
		config,
		JSON.stringify({
			plugins: ['-opencode.browser', { package: `file://${limitless}`, options: limitlessOptions }],
			...(providers ? { providers } : {}),
		}),
	)
	const models = catalogName && join(directory, 'models.json')
	if (models) await writeFile(models, JSON.stringify(catalogs[catalogName]))
	const child = spawn(opencode, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
		cwd: home,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...env,
			OPENCODE_CONFIG: config,
			OPENCODE_PASSWORD: password,
			...(models ? { OPENCODE_MODELS_PATH: models } : {}),
		},
	})
	let log = ''
	const exited = new Promise((resolve) => child.once('exit', resolve))
	const url = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${name}: OpenCode did not listen`)), 30_000)
		const read = (chunk) => {
			log += chunk
			const match = /server listening on (http:\/\/127\.0\.0\.1:[0-9]+)/.exec(log)
			if (!match) return
			clearTimeout(timer)
			resolve(match[1])
		}
		child.stdout.on('data', read)
		child.stderr.on('data', read)
		child.once('exit', () => reject(new Error(`${name}: OpenCode exited before listening\n${log}`)))
	})
	const server = {
		name,
		home,
		async api(path, { method = 'GET', body } = {}) {
			const target = new URL(path, url)
			target.searchParams.set('location[directory]', home)
			const response = await fetch(target, {
				method,
				headers: { authorization, 'content-type': 'application/json' },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(30_000),
			})
			const text = await response.text()
			assert(response.ok, `${name}: ${method} ${path} returned ${response.status}: ${text}`)
			return text ? JSON.parse(text) : undefined
		},
		async stop() {
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
			if (!(await Promise.race([exited.then(() => true), delay(10_000, false)])))
				child.kill('SIGKILL')
			await exited
			output.push(log)
		},
	}
	servers.push(server)
	await activated(server)
	return server
}

async function activated(server) {
	const deadline = Date.now() + 30_000
	for (;;) {
		const plugins = await server.api('/api/plugin')
		const plugin = (plugins.data ?? plugins).find((entry) => entry.id === 'limitless')
		assert.notEqual(plugin?.state.status, 'failed', `${server.name}: Limitless failed to activate`)
		if (plugin?.state.status === 'active') return
		assert(Date.now() < deadline, `${server.name}: Limitless did not activate`)
		await delay(50)
	}
}

async function connect(server, value) {
	const created = await server.api('/api/credential', {
		method: 'POST',
		body: { integrationID: 'openai', value, activate: true },
	})
	const { id } = created.data ?? created
	assert(id, `${server.name}: credential creation returned no ID`)
	return id
}

async function activate(server, id) {
	await server.api(`/api/credential/${id}/activate`, { method: 'POST' })
}

async function openaiModels(server) {
	const response = await server.api('/api/model')
	return new Map(
		(response.data ?? response)
			.filter((model) => model.providerID === 'openai')
			.map((model) => [model.id, model]),
	)
}

const codexURL = 'https://chatgpt.com/backend-api/codex'
const routes = {
	apiKey: (model) => (model?.cost.length ?? 0) > 0,
	tokenSharing: (model) => model?.settings?.compaction?.type === 'summary',
	codex: (model) => model?.settings?.baseURL === codexURL,
}

// Credential switches reload providers asynchronously; wait until GPT-6.2 Astra takes the route.
async function settled(server, label, route) {
	const deadline = Date.now() + 15_000
	for (;;) {
		const models = await openaiModels(server)
		if (route(models.get('gpt-6.2-astra'))) return models
		assert(
			Date.now() < deadline,
			`${server.name}: ${label} did not settle: ${JSON.stringify([...models.keys()])}`,
		)
		await delay(50)
	}
}

function assertBackfilled(models, label) {
	for (const id of backfilled) {
		const model = models.get(id)
		assert(model, `${label}: ${id} is missing`)
		assert.equal(model.enabled, true, `${label}: ${id} is disabled`)
		assert.deepEqual(
			model.variants.map((variant) => variant.id),
			['low', 'medium', 'high', 'xhigh', 'max'],
			`${label}: ${id} has the wrong reasoning variants`,
		)
	}
}

function assertSubscription(models, label) {
	assertBackfilled(models, label)
	for (const id of backfilled) {
		const model = models.get(id)
		assert.deepEqual(
			model.limit,
			{ context: 628_000, input: 500_000, output: 128_000 },
			`${label}: ${id} must use OpenCode's ChatGPT 500k input cap`,
		)
		assert.deepEqual(model.cost, [], `${label}: ${id} must be subscription-priced`)
	}
}

function assertApiKey(models, label) {
	assertBackfilled(models, label)
	for (const id of backfilled) {
		const model = models.get(id)
		assert.deepEqual(model.limit, { context: 1_050_000, input: 922_000, output: 128_000 }, label)
		assert(routes.apiKey(model), `${label}: ${id} lost catalog pricing`)
	}
}

function assertTokenSharing(models, label) {
	assertSubscription(models, label)
	for (const id of backfilled) {
		const model = models.get(id)
		assert.deepEqual(model.settings.compaction, { type: 'summary' }, label)
		assert.equal(model.compatibility?.supportsEffortUpdates, false, label)
	}
	for (const id of ['gpt-6-astra', 'gpt-6.1-sol'])
		assert(models.has(id), `${label}: the backfill dropped catalog model ${id}`)
}

async function assertProvider(server, label, settings) {
	const response = await server.api('/api/provider/openai')
	const provider = response.data ?? response
	for (const [key, value] of Object.entries(settings))
		assert.equal(provider.settings?.[key], value, `${label}: provider ${key}`)
}

try {
	const { home, env } = await isolated('version')
	const { stdout: version } = await promisify(execFile)(opencode, ['--version'], { cwd: home, env })
	assert.equal(
		version.trim(),
		'opencode v2.3.2',
		'Recheck the GPT-6.2 backfill on OpenCode upgrades',
	)

	// A stale catalog lacks GPT-6.2 for every OpenAI connection; one server covers switches and reloads.
	const stale = await start('stale', { catalog: 'stale' })
	const apiKey = await connect(stale, credentials.apiKey())
	const staleApiKey = await settled(stale, 'API key', routes.apiKey)
	assertApiKey(staleApiKey, 'stale catalog with an API key')
	await assertProvider(stale, 'API key', { baseURL: 'https://api.openai.com/v1' })

	await connect(stale, credentials.tokenSharing())
	assertTokenSharing(
		await settled(stale, 'token sharing', routes.tokenSharing),
		'stale catalog with ChatGPT token sharing',
	)
	await assertProvider(stale, 'token sharing', {
		baseURL: 'https://api.openai.com/v1',
		transport: 'http',
	})

	const codex = await connect(stale, credentials.legacyCodex())
	const staleCodex = await settled(stale, 'legacy Codex', routes.codex)
	assertSubscription(staleCodex, 'stale catalog with legacy Codex')
	await assertProvider(stale, 'legacy Codex', { baseURL: codexURL })

	await activate(stale, apiKey)
	assert.deepEqual(
		await settled(stale, 'switch back to API key', routes.apiKey),
		staleApiKey,
		'Switching accounts back must restore the API-key definitions',
	)
	await activate(stale, codex)
	assertSubscription(
		await settled(stale, 'switch back to legacy Codex', routes.codex),
		'switch back to legacy Codex',
	)
	await stale.stop()

	// The checked-in definitions must equal what OpenCode builds from the canonical catalog entry.
	const fresh = await start('fresh', { catalog: 'fresh' })
	await connect(fresh, credentials.apiKey())
	const freshApiKey = await settled(fresh, 'API key', routes.apiKey)
	await connect(fresh, credentials.legacyCodex())
	const freshCodex = await settled(fresh, 'legacy Codex', routes.codex)
	for (const id of backfilled) {
		assert.deepEqual(
			staleApiKey.get(id),
			freshApiKey.get(id),
			`The ${id} backfill diverges from OpenCode's catalog definition`,
		)
		assert.deepEqual(
			staleCodex.get(id),
			freshCodex.get(id),
			`The ${id} backfill diverges from OpenCode's legacy Codex definition`,
		)
	}
	await connect(fresh, credentials.tokenSharing())
	assertTokenSharing(
		await settled(fresh, 'token sharing', routes.tokenSharing),
		'fresh catalog with ChatGPT token sharing',
	)
	await fresh.stop()

	// A catalog definition present at the backfill wins over the checked-in metadata.
	const updated = await start('newer', { catalog: 'newer' })
	await connect(updated, credentials.apiKey())
	const updatedModels = await settled(updated, 'API key', routes.apiKey)
	const astra = updatedModels.get('gpt-6.2-astra')
	assert.equal(astra.name, 'GPT-6.2 Astra Catalog', 'The backfill replaced a catalog definition')
	assert.deepEqual(astra.limit, { context: 400_000, input: 272_000, output: 64_000 })
	assert.deepEqual(updatedModels.get('gpt-6.2-sol'), freshApiKey.get('gpt-6.2-sol'))
	await updated.stop()

	// With OpenCode's bundled catalog, later model configuration still applies to the backfill.
	const configured = await start('configured', {
		providers: { openai: { models: { 'gpt-6.2-sol': { disabled: true } } } },
	})
	await connect(configured, credentials.tokenSharing())
	const configuredModels = await settled(configured, 'token sharing', routes.tokenSharing)
	assert(!configuredModels.has('gpt-6.2-sol'), 'The backfill re-enabled a disabled model')
	assert.deepEqual(configuredModels.get('gpt-6.2-astra').limit, {
		context: 628_000,
		input: 500_000,
		output: 128_000,
	})
	await configured.stop()

	const removed = await start('removed', {
		catalog: 'stale',
		limitlessOptions: { providers: { disabled: ['openai'] } },
	})
	await connect(removed, credentials.tokenSharing())
	for (const deadline = Date.now() + 1_000; Date.now() < deadline; await delay(50))
		assert.equal(
			(await openaiModels(removed)).size,
			0,
			'The backfill resurrected a removed provider',
		)
	await removed.stop()

	for (const log of output)
		for (const value of secrets)
			assert(!log.includes(value), 'A synthetic credential leaked to OpenCode output')
	console.log('Validated the GPT-6.2 OpenAI catalog backfill')
} catch (error) {
	for (const server of servers) await server.stop()
	for (const log of output) console.error(log)
	throw error
} finally {
	await rm(root, { recursive: true, force: true })
}
