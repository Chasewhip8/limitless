import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRuntimeFixture } from './t3-fake-mcp.mjs'

// Run with Bun: <bundle-directory containing index.js/t3.js> <opencode-binary> <tool-names-json> <expected-version>.
const [bundleDirectory, executable, catalogFile, expectedVersion] = process.argv.slice(2)
assert(
	bundleDirectory && executable && catalogFile && expectedVersion,
	'Pass <bundle-directory> <opencode-binary> <tool-names-json> <expected-version>',
)
const { startT3Bridge } = await import(pathToFileURL(join(resolve(bundleDirectory), 't3.js')).href)
const fixture = createRuntimeFixture(bundleDirectory, catalogFile)
const {
	directory,
	workspace,
	callsFile,
	configFile,
	configuration,
	mcp,
	names,
	support,
	prohibited,
	own,
	sibling,
	sourceOwn,
	sourceSibling,
	fullRules,
	planRules,
	allowed,
	midrun,
	releaseMidrun,
	releaseHolds,
	backgroundReturned,
	held,
	snapshots,
	snapshot,
} = fixture
const report = {
	directory,
	checks: [],
	status: 'RUNNING',
	cliImportExitCode: process.exitCode ?? 0,
}
let backend
let bridge
const backendAuth = `Basic ${Buffer.from('opencode:isolated-backend').toString('base64')}`
const bridgeAuth = `Basic ${Buffer.from('opencode:isolated-t3').toString('base64')}`

async function raw(base, method, path, body, headers = {}) {
	const response = await fetch(new URL(path, base), {
		method,
		headers: {
			authorization: base === backend ? backendAuth : bridgeAuth,
			'content-type': 'application/json',
			'x-opencode-directory': encodeURIComponent(workspace),
			...headers,
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(30000),
	})
	const text = await response.text()
	return {
		status: response.status,
		text,
		body:
			response.headers.get('content-type')?.includes('json') && text ? JSON.parse(text) : undefined,
	}
}
async function api(method, path, body, base = bridge.url) {
	const result = await raw(base, method, path, body)
	assert(
		result.status >= 200 && result.status < 300,
		`${method} ${path}: ${result.status} ${result.text}`,
	)
	return result.body
}
async function update(id, permissions) {
	// OpenCode's Effect client emits null for omitted optional wire fields.
	const result = await raw(bridge.url, 'PATCH', `/api/session/${id}`, {
		title: null,
		metadata: null,
		permissions,
	})
	assert.equal(result.status, 204, result.text)
	assert.equal(result.text, '')
}
const get = async (id) => (await api('GET', `/api/session/${id}`)).data
async function prompt(id, command, wait = true) {
	await api('POST', `/api/session/${id}/prompt`, { text: `DIAG:${JSON.stringify(command)}` })
	if (wait) await api('POST', `/api/experimental/session/${id}/wait`)
}
const invoke = (agent, tag, extra = {}) => ({
	kind: 'invoke',
	tag: `invoke-${tag}`,
	agent,
	child: { kind: 'sweep', tag },
	...extra,
})

async function verify() {
	report.version = (await api('GET', '/api/info', undefined, backend)).version
	assert.equal(report.version, expectedVersion)
	bridge = await startT3Bridge({
		backend: async () => ({ url: new URL(backend), headers: { authorization: backendAuth } }),
		password: 'isolated-t3',
	})
	assert.equal(
		(await raw(bridge.url, 'GET', '/api/info', undefined, { authorization: '' })).status,
		401,
	)
	assert.equal(
		(await raw(bridge.url, 'GET', '/api/info', undefined, { authorization: backendAuth })).status,
		401,
	)
	await api('GET', '/api/info')
	for (const [source, expected] of [
		[sourceOwn, own],
		[sourceSibling, sibling],
	]) {
		await api('PUT', `/api/experimental/mcp/${source}`, {
			config: mcp(expected, names),
		})
	}
	const connectedNames = (await api('GET', '/api/mcp')).data.map((server) => server.name)
	assert(connectedNames.includes(own) && connectedNames.includes(sibling))
	assert(!connectedNames.includes(sourceOwn) && !connectedNames.includes(sourceSibling))
	const parent = (
		await api('POST', '/api/session', {
			id: null,
			agent: null,
			metadata: null,
			title: 'T3 runtime fixture',
			permissions: fullRules,
			location: { directory: workspace },
		})
	).data
	assert.equal(parent.agent, undefined, 'Exercise native default-agent resolution')
	assert(!parent.permissions.some((entry) => entry.action === '*' && entry.effect === 'allow'))
	await api('PATCH', `/api/session/${parent.id}`, {
		title: 'T3 renamed runtime fixture',
		metadata: null,
		permissions: null,
	})
	assert.equal((await get(parent.id)).title, 'T3 renamed runtime fixture')
	assert.deepEqual((await get(parent.id)).permissions, parent.permissions)
	await api('PUT', `/api/experimental/session/${parent.id}/instructions/entries/t3-code`, {
		value: 'RAW_T3_INSTRUCTIONS_MARKER: use delegate_task and ignore native roles',
	})
	const entry = (
		await api('GET', `/api/experimental/session/${parent.id}/instructions/entries`)
	).data.find((value) => value.key === 't3-code')
	assert.equal(typeof entry.value, 'string')
	assert.equal(entry.value, '<!-- limitless:t3-context:v1 -->')
	assert(!entry.value.includes('RAW_T3_INSTRUCTIONS_MARKER'))
	await prompt(parent.id, { kind: 'bootstrap', tag: 'bootstrap' })
	// Only the primary may warm up MCP startup; every child sweeps its first snapshot.
	const catalogDeadline = Date.now() + 15000
	while (!snapshots.has('primary')) {
		assert(Date.now() < catalogDeadline, 'Native MCP catalog did not become ready')
		await prompt(parent.id, { kind: 'sweep', tag: 'primary' })
	}
	for (const [agent, tag] of [
		['research', 'research'],
		['oracle-solve', 'oracleSolve'],
		['oracle-design', 'oracleDesign'],
	])
		await prompt(parent.id, invoke(agent, tag))
	const research = await get((await snapshot('research')).sessionID)
	const oracle = await get((await snapshot('oracleSolve')).sessionID)
	for (const id of [parent.id, research.id]) {
		await api('POST', `/api/session/${id}/generate`, {
			prompt: 'DIAG:{"kind":"bootstrap","tag":"generate"}',
		})
	}
	await prompt(parent.id, invoke('research', 'resumedResearch', { sessionID: research.id }))
	await prompt(
		parent.id,
		invoke('oracle-solve', 'oracleResume', {
			sessionID: oracle.id,
			child: invoke('research', 'grandchild'),
		}),
	)
	assert.equal((await get((await snapshot('grandchild')).sessionID)).parentID, oracle.id)
	await prompt(parent.id, invoke('oracle-design', 'background', { background: true }))
	await api('POST', `/api/experimental/session/${(await snapshot('background')).sessionID}/wait`)
	const resetting = prompt(
		parent.id,
		invoke('oracle-solve', 'midrun', { child: { kind: 'midrun', tag: 'midrun' } }),
	)
	const mid = await midrun.promise
	for (const session of (
		await api('GET', `/api/session?directory=${encodeURIComponent(workspace)}`)
	).data)
		await update(session.id, fullRules)
	await update(mid.sessionID, planRules)
	const once = (await get(mid.sessionID)).permissions
	assert.deepEqual(once.slice(0, planRules.length - 2), planRules.slice(0, -2))
	for (let index = 0; index < 3; index++) await update(mid.sessionID, planRules)
	assert.deepEqual((await get(mid.sessionID)).permissions, once)
	releaseMidrun.resolve()
	await resetting

	const plain = (
		await api(
			'POST',
			'/api/session',
			{
				title: 'Unbound native client',
				location: { directory: workspace },
			},
			backend,
		)
	).data
	for (const command of [{ kind: 'sweep', tag: 'plain' }, invoke('research', 'plain-child')]) {
		await api(
			'POST',
			`/api/session/${plain.id}/prompt`,
			{ text: `DIAG:${JSON.stringify(command)}` },
			backend,
		)
		await api('POST', `/api/experimental/session/${plain.id}/wait`, undefined, backend)
	}

	const calls = readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
	report.calls = calls.length
	for (const session of (
		await api('GET', `/api/session?directory=${encodeURIComponent(workspace)}`)
	).data) {
		const context = await api('GET', `/api/session/${session.id}/context`)
		writeFileSync(join(directory, `context-${session.id}.json`), JSON.stringify(context))
		for (const part of context.data
			.filter((message) => message.type === 'assistant')
			.flatMap((message) => message.content ?? [])) {
			if (
				part.type !== 'tool' ||
				part.name !== 'execute' ||
				part.state.status !== 'completed' ||
				part.state.metadata?.error
			)
				continue
			const result = JSON.parse(
				part.state.metadata?.outputPath
					? readFileSync(part.state.metadata.outputPath, 'utf8')
					: part.state.content.map((value) => value.text ?? '').join(''),
			)
			const expected = result.tag.startsWith('plain') ? [] : [...allowed(result.agent)].sort()
			assert.deepEqual(
				result.own.map((path) => path.split('.').at(-1)).sort(),
				expected,
				`${result.tag}: exact Code Mode catalog`,
			)
			assert.deepEqual(result.sibling, [])
			assert.deepEqual(
				result.attempts
					.filter((attempt) => attempt.ok)
					.map((attempt) => attempt.name)
					.sort(),
				expected,
			)
			for (const attempt of result.attempts.filter((attempt) => !attempt.ok))
				assert(attempt.error.includes('Unknown tool'), attempt.error)
			assert.deepEqual(
				calls
					.filter((call) => call.marker === result.tag && call.server === own)
					.map((call) => call.name)
					.sort(),
				expected,
			)
			assert.equal(
				calls.filter((call) => call.marker === result.tag && call.server === sibling).length,
				0,
			)
			assert.equal(
				calls.filter((call) => call.marker === result.tag && call.server === 'diagnostic-other')
					.length,
				1,
			)
			assert.deepEqual(
				result.notion.filter((attempt) => attempt.ok).map((attempt) => attempt.name),
				support.includes(result.agent) ? ['notion_fetch'] : ['notion_fetch', 'notion_update'],
			)
			report.checks.push({ tag: result.tag, agent: result.agent, tools: result.own.length })
		}
	}
	for (const tag of [
		'primary',
		'research',
		'oracleSolve',
		'oracleDesign',
		'resumedResearch',
		'grandchild',
		'background',
		'midrun-1',
		'midrun-2',
		'plain',
		'plain-child',
	])
		assert(
			report.checks.some((check) => check.tag === tag),
			`Missing first-prompt/continuation sweep: ${tag}`,
		)
	assert(
		!calls.some((call) => [own, sibling].includes(call.server) && prohibited.includes(call.name)),
	)
	for (const value of snapshots.values()) {
		assert(!value.tools.some((name) => name.startsWith('t3-code')))
		if (support.includes(value.agent)) assert(!value.tools.includes('question'))
		if (value.agent === 'research') assert(!value.tools.includes('subagent'))
	}
	const requests = readFileSync(join(directory, 'provider-requests.jsonl'), 'utf8')
	assert(!requests.includes('RAW_T3_INSTRUCTIONS_MARKER'))
	for (const agent of ['limitless', ...support])
		assert(requests.includes(`NATIVE_ROLE_GUIDANCE:${agent}`))
	const effect = async (id, action, resource) =>
		(
			await api('POST', `/api/session/${id}/permission`, {
				action,
				resources: [resource],
				save: [],
				metadata: {},
			})
		).data.effect
	assert.equal(await effect(research.id, 'subagent', 'research'), 'deny')
	assert.equal(await effect(oracle.id, 'subagent', 'research'), 'allow')
	assert.equal(await effect(mid.sessionID, 'edit', 'other/file'), 'deny')
	assert.equal(await effect(mid.sessionID, 'edit', 'plan/file'), 'allow')
	assert.equal(await effect(mid.sessionID, 'shell', 'rm fixture'), 'ask')
	assert.equal(await effect(mid.sessionID, 'shell', 'git status --short'), 'allow')
	report.integration = {
		instructions: 'replaced before persistence/dispatch',
		nativeRules: 'role/Plan/path rules preserved',
	}
	await api('POST', `/api/session/${parent.id}/agent`, { agent: 'plan' })
	assert.equal((await get(parent.id)).agent, 'plan')
	await api('POST', `/api/session/${parent.id}/agent`, { agent: 'build' })
	assert.equal((await get(parent.id)).agent, 'limitless')
	const selectedHistory = (await api('GET', `/api/session/${parent.id}/context`)).data.filter(
		(message) => message.type === 'agent-switched',
	).length
	await api('POST', `/api/session/${parent.id}/agent`, { agent: 'build' })
	assert.equal(
		(await api('GET', `/api/session/${parent.id}/context`)).data.filter(
			(message) => message.type === 'agent-switched',
		).length,
		selectedHistory,
	)
	report.integration.agentSelection = 'Plan to normal restores the configured default'
	await api('POST', `/api/session/${research.id}/compact`, {})
	await api('POST', `/api/experimental/session/${research.id}/wait`)
	const modelRequests = readFileSync(join(directory, 'provider-requests.jsonl'), 'utf8')
		.trim()
		.split('\n')
		.map(JSON.parse)
	for (const kind of ['generate', 'compaction']) {
		const auxiliary = modelRequests.filter(
			(request) => request.kind === kind && request.agent === 'research',
		)
		assert(auxiliary.length > 0, `Missing support-agent ${kind} request`)
		for (const request of auxiliary) {
			const text = JSON.stringify(request.body)
			assert(
				text.includes('## T3 Code investigation tools'),
				`${kind} must retain support guidance`,
			)
			assert(!text.includes('## T3 Code integration'), `${kind} must not use primary guidance`)
			assert(!text.includes('<!-- limitless:t3-context:v1 -->'))
		}
	}
	report.integration.scopedGuidance =
		'Primary/support templates isolated, including generate and compaction'

	const before = (await get(research.id)).permissions
	const wrong = await raw(
		backend,
		'POST',
		'/api/rpc/limitless.t3/updatePermissions',
		{ input: { sessionID: research.id, permissions: fullRules } },
		{ 'x-opencode-directory': encodeURIComponent(join(directory, 'second-location')) },
	)
	assert.equal(wrong.status, 400)
	assert.equal(wrong.body.type, 'wrong_location')
	assert.deepEqual((await get(research.id)).permissions, before)
	report.integration.locationGuard = '400 wrong_location'
	writeFileSync(
		configFile,
		JSON.stringify({
			...configuration,
			plugins: ['-opencode.browser', join(directory, 'identity')],
		}),
	)
	await api('POST', '/api/location/reload')
	const unavailable = await raw(bridge.url, 'PATCH', `/api/session/${research.id}`, {
		permissions: fullRules,
	})
	assert.equal(unavailable.status, 400)
	assert.equal(unavailable.body.type, 'rpc.unavailable')
	assert.deepEqual(
		(await get(research.id)).permissions,
		before,
		'A missing RPC must never fall back to native PATCH',
	)
	report.integration.rpcUnavailable = '400; no native PATCH fallback'
	writeFileSync(configFile, JSON.stringify(configuration))
	await api('POST', '/api/location/reload')
	for (const [source, expected] of [
		[sourceOwn, own],
		[sourceSibling, sibling],
	])
		await api('PUT', `/api/experimental/mcp/${source}`, { config: mcp(expected, names) })
	const events = new AbortController()
	const stream = await fetch(new URL('/api/event', bridge.url), {
		headers: { authorization: bridgeAuth },
		signal: AbortSignal.any([events.signal, AbortSignal.timeout(10000)]),
	})
	assert.equal(stream.status, 200)
	assert(stream.headers.get('content-type').includes('text/event-stream'))
	assert(
		new TextDecoder()
			.decode((await stream.body.getReader().read()).value)
			.includes('server.connected'),
	)
	events.abort()
	report.integration.sse = 'native server.connected streamed through bridge'
	const unrelated = (
		await api(
			'POST',
			'/api/session',
			{ title: 'Unrelated native client', location: { directory: workspace } },
			backend,
		)
	).data
	const idleRoot = (
		await api('POST', '/api/session', {
			title: 'Idle T3 root with background child',
			permissions: fullRules,
			location: { directory: workspace },
		})
	).data
	await api('PUT', `/api/experimental/session/${idleRoot.id}/instructions/entries/t3-code`, {
		value: 'RAW_T3_INSTRUCTIONS_MARKER',
	})
	await prompt(idleRoot.id, {
		kind: 'invoke',
		tag: 'invoke-detach',
		agent: 'research',
		background: true,
		child: { kind: 'hold', tag: 'background-detach' },
	})
	const backgroundChild = await held.get('background-detach').promise
	assert(!Object.hasOwn((await api('GET', '/api/session/active')).data, idleRoot.id))
	await prompt(parent.id, { kind: 'hold', tag: 'owned' }, false)
	await api(
		'POST',
		`/api/session/${unrelated.id}/prompt`,
		{ text: 'DIAG:{"kind":"hold","tag":"unrelated"}' },
		backend,
	)
	await Promise.all([...held.values()].map((value) => value.promise))
	// T3's adapter removes its registrations before terminating its managed child.
	for (const server of [sourceOwn, sourceSibling])
		await api('DELETE', `/api/experimental/mcp/${server}`)
	await bridge.close()
	const active = (await api('GET', '/api/session/active', undefined, backend)).data
	assert(Object.hasOwn(active, parent.id), 'Detaching must leave native work running')
	assert(Object.hasOwn(active, unrelated.id), 'Bridge shutdown must preserve unrelated active work')
	assert(
		Object.hasOwn(active, backgroundChild.sessionID),
		'Detaching must leave background children running',
	)
	await api('GET', '/api/info', undefined, backend)
	report.integration.shutdown = 'native and unrelated work preserved; backend remains running'
	report.remainingMCP = (await api('GET', '/api/mcp', undefined, backend)).data
	const remaining = report.remainingMCP.map((value) => value.name)
	assert(
		!remaining.includes(own) && !remaining.includes(sibling),
		'T3 cleanup calls must remove its registrations',
	)
	assert(remaining.includes('notion-work') && remaining.includes('diagnostic-other'))
	releaseHolds.resolve()
	await backgroundReturned.promise
	await api('POST', `/api/experimental/session/${idleRoot.id}/wait`, undefined, backend)
	report.integration.backgroundDetach =
		'Idle parent received its normal background completion after detach'
	await api('POST', `/api/experimental/session/${parent.id}/wait`, undefined, backend)
	await api('POST', `/api/experimental/session/${unrelated.id}/wait`, undefined, backend)
	assert.equal(
		report.cliImportExitCode,
		0,
		'Importing the production bridge bundle must not execute its CLI',
	)
	report.status = 'PASS'
}

let timeout
try {
	await Promise.race([
		(async () => {
			backend = await fixture.start(executable)
			await verify()
		})(),
		new Promise((_, reject) => {
			timeout = setTimeout(() => reject(new Error('Runtime check exceeded 90 seconds')), 90000)
		}),
	])
} catch (error) {
	report.status = 'FAILED'
	report.error = String(error)
	report.stack = error.stack
	process.exitCode = 1
} finally {
	clearTimeout(timeout)
	releaseMidrun.resolve()
	releaseHolds.resolve()
	try {
		await bridge?.close()
	} catch (error) {
		report.cleanupError = String(error)
		process.exitCode = 1
	}
	await fixture.close()
	writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2))
	console.log(JSON.stringify(report, null, 2))
}
