import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

// All simulated services and model responses live here; production policy is never copied.
export function createRuntimeFixture(bundleDirectory, catalogFile) {
	const names = JSON.parse(readFileSync(catalogFile, 'utf8'))
	assert.equal(names.length, 83, 'Review the runtime expectations when T3 changes its catalog')
	const browser = [
		'preview_click',
		'preview_dialog',
		'preview_drag',
		'preview_evaluate',
		'preview_hover',
		'preview_navigate',
		'preview_open',
		'preview_press',
		'preview_recording_start',
		'preview_recording_stop',
		'preview_resize',
		'preview_scroll',
		'preview_select',
		'preview_set_appearance',
		'preview_snapshot',
		'preview_status',
		'preview_type',
		'preview_upload',
		'preview_wait_for',
		't3_preview_close',
		't3_preview_list',
	]
	const support = ['research', 'oracle-solve', 'oracle-design']
	const prohibited = ['delegate_task', 'task_status', 'task_cancel']
	const sourceOwn = 't3-code-thread_with_underscores'
	const sourceSibling = 't3-code-thread_with_underscores_child'
	const own = 't3-code-a2e5ba16d672e66b1ab8ab7b78d2f175'
	const sibling = 't3-code-ff8d3d9247d63737afe9b4ba7415199e'
	const rule = (action, effect, resource = '*') => ({ action, resource, effect })
	const anchors = [rule('t3-code-*', 'deny'), rule(`${sourceOwn}_*`, 'allow')]
	const grants = [rule('read', 'allow', 'documents/*.txt'), rule('shell', 'allow', 'git status *')]
	const fullRules = [rule('*', 'allow'), ...grants, ...anchors]
	const planRules = [
		rule('shell', 'ask'),
		rule('edit', 'ask'),
		rule('external_directory', 'ask'),
		...grants,
		rule('edit', 'deny'),
		rule('edit', 'allow', 'plan/*'),
		...anchors,
	]
	const allowed = (agent) =>
		support.includes(agent) ? browser : names.filter((name) => !prohibited.includes(name))
	const temporary = process.env.TMPDIR ?? '/tmp/opencode'
	mkdirSync(temporary, { recursive: true })
	const directory = mkdtempSync(join(temporary, 'limitless-t3-runtime-'))
	for (const name of [
		'workspace-%20-日本語',
		'second-location',
		'home',
		'config',
		'data',
		'state',
		'cache',
		'runtime',
		'identity',
	])
		mkdirSync(join(directory, name))
	const workspace = join(directory, 'workspace-%20-日本語')
	const callsFile = join(directory, 'mcp-calls.jsonl')
	writeFileSync(callsFile, '')
	const deferred = () => {
		let resolve
		const promise = new Promise((done) => {
			resolve = done
		})
		return { promise, resolve }
	}
	const ready = deferred()
	const midrun = deferred()
	const releaseMidrun = deferred()
	const releaseHolds = deferred()
	const backgroundReturned = deferred()
	const held = new Map(
		['owned', 'unrelated', 'background-detach'].map((name) => [name, deferred()]),
	)
	const snapshots = new Map()
	const snapshotWaiters = new Map()
	const phases = new Map()
	const executed = new Set()
	let backend
	let processHandle
	let stdoutTask
	let stderrTask
	function sweepCode(agent, tag) {
		return `
const own=search({namespace:${JSON.stringify(own)},limit:200}).items.map(item=>item.path);
const sibling=search({namespace:${JSON.stringify(sibling)},limit:200}).items.map(item=>item.path);
const attempts=[];
for(const server of ${JSON.stringify([own, sibling])}) for(const name of ${JSON.stringify(names)}) {
 try {await tools[server][name]({marker:${JSON.stringify(tag)}});attempts.push({server,name,ok:true});}
 catch(error){attempts.push({server,name,ok:false,error:String(error)});}
}
const notion=[];
for(const name of ['notion_fetch','notion_update']) {
 try {await tools['notion-work'][name]({marker:${JSON.stringify(tag)}});notion.push({name,ok:true});}
 catch(error){notion.push({name,ok:false,error:String(error)});}
}
await tools['diagnostic-other'].delegate_task({marker:${JSON.stringify(tag)}});
return {tag:${JSON.stringify(tag)},agent:${JSON.stringify(agent)},own,sibling,attempts,notion};`
	}
	const provider = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			const body = await request.json()
			const sessionID = request.headers.get('x-test-session')
			const agent = request.headers.get('x-test-agent')
			const kind = request.headers.get('x-test-kind')
			const t3Bound = request.headers.get('x-test-t3-bound') === 'true'
			appendFileSync(
				join(directory, 'provider-requests.jsonl'),
				`${JSON.stringify({ sessionID, agent, kind, t3Bound, body })}\n`,
			)
			const line = (body.messages ?? [])
				.filter((message) => message.role === 'user')
				.flatMap((message) =>
					(typeof message.content === 'string'
						? message.content
						: JSON.stringify(message.content)
					).split('\n'),
				)
				.filter((text) => text.startsWith('DIAG:'))
				.at(-1)
			const command =
				kind === 'compaction'
					? { kind: 'bootstrap', tag: 'compaction' }
					: line
						? JSON.parse(line.slice(5))
						: undefined
			if (command) {
				const sent = JSON.stringify(body.messages)
				if (!t3Bound) {
					assert(!sent.includes('## T3 Code integration'))
					assert(!sent.includes('## T3 Code investigation tools'))
				} else {
					assert(
						!sent.includes('<!-- limitless:t3-context:v1 -->'),
						'T3 marker must be expanded before dispatch',
					)
					assert(
						sent.includes(
							support.includes(agent) ? '## T3 Code investigation tools' : '## T3 Code integration',
						),
					)
					const heading = support.includes(agent)
						? '## T3 Code investigation tools'
						: '## T3 Code integration'
					assert.equal(sent.split(heading).length - 1, 1, 'Guidance must appear exactly once')
					if (support.includes(agent))
						assert(
							!sent.includes('## T3 Code integration'),
							'Children must not inherit primary-only guidance',
						)
				}
			}
			const key = `${sessionID}/${command?.tag}`
			const phase = (phases.get(key) ?? 0) + 1
			phases.set(key, phase)
			if (command?.tag === 'invoke-detach' && phase >= 3) backgroundReturned.resolve({ sessionID })
			const tool = (name, input) => ({
				tool_calls: [
					{
						index: 0,
						id: `call_${crypto.randomUUID()}`,
						type: 'function',
						function: { name, arguments: JSON.stringify(input) },
					},
				],
			})
			let delta = { content: 'DONE' }
			if (command?.kind === 'invoke' && phase === 1)
				delta = tool('subagent', {
					agent: command.agent,
					description: 'Local runtime fixture',
					prompt: `DIAG:${JSON.stringify(command.child)}`,
					...(command.sessionID ? { sessionID: command.sessionID } : {}),
					...(command.background ? { background: true } : {}),
				})
			if (command?.kind === 'sweep' || command?.kind === 'midrun') {
				const catalog = JSON.stringify(body.messages)
				if (
					command.tag === 'primary' &&
					(!catalog.includes(`${own} (${allowed(agent).length} tools`) ||
						!catalog.includes('notion-work (2 tools'))
				)
					delta = { content: 'CATALOG_NOT_READY' }
				else {
					if (!snapshots.has(command.tag)) {
						const snapshot = {
							sessionID,
							agent,
							tools: body.tools.map((entry) => entry.function.name),
						}
						snapshots.set(command.tag, snapshot)
						snapshotWaiters.get(command.tag)?.resolve(snapshot)
					}
					if (command.kind === 'midrun' && phase === 1) {
						midrun.resolve({ sessionID })
						await releaseMidrun.promise
					}
					if (!executed.has(key) || (command.kind === 'midrun' && phase === 2)) {
						executed.add(key)
						delta = tool('execute', {
							code: sweepCode(agent, command.kind === 'midrun' ? `midrun-${phase}` : command.tag),
						})
					}
				}
			}
			if (command?.kind === 'hold') {
				held.get(command.tag).resolve({ sessionID })
				await releaseHolds.promise
			}
			const chunk = (value, finish_reason = null) => ({
				id: 'chatcmpl_fixture',
				object: 'chat.completion.chunk',
				created: 1,
				model: 'fixture',
				choices: [{ index: 0, delta: value, finish_reason }],
			})
			return new Response(
				`${[chunk({ role: 'assistant' }), chunk(delta), chunk({}, delta.tool_calls ? 'tool_calls' : 'stop')].map((value) => `data: ${JSON.stringify(value)}\n\n`).join('')}data: [DONE]\n\n`,
				{ headers: { 'content-type': 'text/event-stream' } },
			)
		},
	})
	// Identity headers only: this test plugin cannot change permissions or tools.
	writeFileSync(join(directory, 'identity', 'package.json'), JSON.stringify({ type: 'module' }))
	writeFileSync(
		join(directory, 'identity', 'index.js'),
		`export default {id:'runtime-fixture-identity',async setup(ctx){await ctx.session.hook('model.request',async event=>{const session=await ctx.session.get({sessionID:event.sessionID});event.headers['x-test-session']=event.sessionID;event.headers['x-test-agent']=session.agent??'limitless';event.headers['x-test-kind']=event.kind;event.headers['x-test-t3-bound']=String((session.permissions??[]).some(rule=>rule.action==='t3-code-*'&&rule.effect==='deny'))})}}`,
	)
	const mcp = (server, tools) => ({
		type: 'local',
		protocol: 'legacy',
		command: [
			process.execPath,
			fileURLToPath(import.meta.url),
			server,
			JSON.stringify(tools),
			callsFile,
		],
	})
	const configuration = {
		default_agent: 'limitless',
		model: 'fixture/fixture',
		experimental: { subagent_depth: 2 },
		permissions: [rule('*', 'allow'), rule('t3-code-*', 'deny'), rule('t3-code_*', 'deny')],
		plugins: ['-opencode.browser', resolve(bundleDirectory), join(directory, 'identity')],
		providers: {
			fixture: {
				package: '@opencode/ai/providers/openai-compatible',
				env: [],
				settings: { baseURL: `${provider.url}v1`, apiKey: 'fixture', transport: 'http' },
				models: {
					fixture: {
						limit: { context: 1000000, output: 16000 },
						capabilities: { tools: true, input: ['text'], output: ['text'] },
					},
				},
			},
		},
		agents: Object.fromEntries(
			['limitless', ...support].map((id) => [
				id,
				{
					mode: id === 'limitless' ? 'primary' : 'subagent',
					description: 'Native runtime fixture',
					model: 'fixture/fixture',
					system: `NATIVE_ROLE_GUIDANCE:${id}`,
					permissions:
						id === 'limitless'
							? []
							: [
									rule('question', 'deny'),
									rule('subagent', 'deny'),
									...(id.startsWith('oracle-') ? [rule('subagent', 'allow', 'research')] : []),
									rule('notion-work_*', 'deny'),
									rule('notion-work_notion_fetch', 'allow'),
								],
				},
			]),
		),
		mcp: {
			servers: {
				'notion-work': mcp('notion-work', ['notion_fetch', 'notion_update']),
				'diagnostic-other': mcp('diagnostic-other', ['delegate_task']),
			},
		},
	}
	const configFile = join(directory, 'opencode.json')
	writeFileSync(configFile, JSON.stringify(configuration, null, 2))
	return {
		names,
		directory,
		workspace,
		callsFile,
		configFile,
		configuration,
		mcp,
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
		snapshotWaiters,
		async start(executable) {
			processHandle = Bun.spawn(
				[
					resolve(executable),
					'serve',
					'--hostname',
					'127.0.0.1',
					'--port',
					'0',
					'--log-level',
					'debug',
				],
				{
					cwd: workspace,
					stdout: 'pipe',
					stderr: 'pipe',
					env: {
						PATH: process.env.PATH,
						HOME: join(directory, 'home'),
						XDG_CONFIG_HOME: join(directory, 'config'),
						XDG_DATA_HOME: join(directory, 'data'),
						XDG_STATE_HOME: join(directory, 'state'),
						XDG_CACHE_HOME: join(directory, 'cache'),
						XDG_RUNTIME_DIR: join(directory, 'runtime'),
						OPENCODE_CONFIG_DIR: join(directory, 'config', 'opencode'),
						OPENCODE_CONFIG: configFile,
						OPENCODE_CONFIG_PROJECT_DISABLE: '1',
						OPENCODE_DISABLE_MODELS_FETCH: '1',
						OPENCODE_DISABLE_FILEWATCHER: '1',
						OPENCODE_DISABLE_FFF: '1',
						OPENCODE_DISABLE_CLAUDE_CODE: '1',
						OPENCODE_PASSWORD: 'isolated-backend',
					},
				},
			)
			stdoutTask = (async () => {
				let output = ''
				for await (const bytes of processHandle.stdout) {
					const text = new TextDecoder().decode(bytes)
					appendFileSync(join(directory, 'stdout.log'), text)
					output += text
					const match = /server listening on (http:\/\/\S+)/.exec(output)
					if (match && !backend) {
						backend = match[1]
						ready.resolve()
					}
				}
			})()
			stderrTask = (async () => {
				for await (const bytes of processHandle.stderr)
					appendFileSync(join(directory, 'stderr.log'), new TextDecoder().decode(bytes))
			})()
			await ready.promise
			return backend
		},
		async close() {
			releaseMidrun.resolve()
			releaseHolds.resolve()
			if (processHandle) {
				processHandle.kill('SIGTERM')
				await processHandle.exited
			}
			provider.stop(true)
			await Promise.all([stdoutTask, stderrTask])
		},
		async snapshot(tag) {
			if (snapshots.has(tag)) return snapshots.get(tag)
			const waiter = deferred()
			snapshotWaiters.set(tag, waiter)
			return waiter.promise
		},
	}
}

async function serveMCP() {
	const [server, catalog, callsFile] = process.argv.slice(2)
	const names = JSON.parse(catalog)
	const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }))
	for await (const line of createInterface({ input: process.stdin })) {
		const request = JSON.parse(line)
		if (request.id === undefined) continue
		switch (request.method) {
			case 'initialize':
				reply(request.id, {
					protocolVersion: request.params.protocolVersion,
					serverInfo: { name: 'limitless-runtime-fixture', version: '1.0.0' },
					capabilities: { tools: {} },
				})
				break
			case 'ping':
				reply(request.id, {})
				break
			case 'tools/list':
				reply(request.id, {
					tools: names.map((name) => ({
						name,
						description: `Local integration fixture: ${name}`,
						inputSchema: {
							type: 'object',
							properties: { marker: { type: 'string' } },
							additionalProperties: false,
						},
					})),
				})
				break
			case 'tools/call':
				appendFileSync(
					callsFile,
					`${JSON.stringify({ server, name: request.params.name, marker: request.params.arguments?.marker })}\n`,
				)
				reply(request.id, {
					content: [{ type: 'text', text: JSON.stringify({ server, name: request.params.name }) }],
				})
				break
			default:
				console.log(
					JSON.stringify({
						jsonrpc: '2.0',
						id: request.id,
						error: { code: -32601, message: request.method },
					}),
				)
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	await serveMCP()
