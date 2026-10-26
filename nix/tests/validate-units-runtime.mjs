import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

// Real OpenCode, the packaged Limitless plugin, a disposable Git project, and
// a scripted model. No Paseo/T3 service or external model account participates.
const [bundleDirectory, executable] = process.argv.slice(2)
assert(bundleDirectory && executable, 'Pass <limitless-package> <opencode-binary>')
const temporary = process.env.LIMITLESS_TEST_TMPDIR ?? '/tmp/opencode'
mkdirSync(temporary, { recursive: true })
const directory = mkdtempSync(join(temporary, 'limitless-native-units-'))
for (const name of ['project', 'home', 'config', 'data', 'state', 'cache', 'runtime', 'identity'])
	mkdirSync(join(directory, name))
const project = join(directory, 'project')
const report = { directory, checks: [], status: 'RUNNING' }
const check = (name) => report.checks.push(name)
function git(...args) {
	const result = spawnSync('git', ['-C', project, ...args], { encoding: 'utf8' })
	assert.equal(result.status, 0, result.stderr)
	return result.stdout.trim()
}
git('init', '-b', 'main')
writeFileSync(join(project, 'README.md'), 'Native Unit fixture\n')
mkdirSync(join(project, 'sub'))
writeFileSync(join(project, 'sub', 'README.md'), 'Subdirectory fixture\n')
writeFileSync(join(project, '.gitignore'), 'opencode.json\nunit-output.txt\n')
git('add', '.')
git(
	'-c',
	'user.name=Fixture',
	'-c',
	'user.email=fixture@example.invalid',
	'commit',
	'-m',
	'Fixture',
)

const delay = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(read, predicate, label, timeout = 30_000) {
	const deadline = Date.now() + timeout
	while (Date.now() < deadline) {
		const value = await read()
		if (predicate(value)) return value
		await delay(25)
	}
	throw new Error(`Timed out: ${label}`)
}
const requests = []
const counts = new Map()
const gates = new Map()
const setupReleases = []
const placed = new Set()
function gate(name) {
	if (!gates.has(name)) {
		let release
		const promise = new Promise((done) => {
			release = done
		})
		gates.set(name, { promise, release })
	}
	return gates.get(name)
}
const toolCall = (name, input) => ({
	tool_calls: [
		{
			index: 0,
			id: `call_${crypto.randomUUID()}`,
			type: 'function',
			function: { name, arguments: JSON.stringify(input) },
		},
	],
})
const textOf = (message) =>
	typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
const commandOf = (messages) => {
	const line = messages
		.filter((message) => message.role === 'user')
		.flatMap((message) => textOf(message).split('\n'))
		.filter((line) => line.startsWith('DIAG:'))
		.at(-1)
	return line ? JSON.parse(line.slice(5)) : undefined
}
const provider = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	idleTimeout: 0,
	async fetch(request) {
		const url = new URL(request.url)
		if (url.pathname === '/placement') {
			const tag = url.searchParams.get('tag')
			placed.add(tag)
			await gate(tag).promise
			return new Response('released')
		}
		const body = await request.json()
		const sessionID = request.headers.get('x-test-session')
		const agent = request.headers.get('x-test-agent')
		const kind = request.headers.get('x-test-kind')
		const command = kind === 'primary' ? commandOf(body.messages ?? []) : undefined
		const key = `${sessionID}:${command?.tag}`
		const phase = (counts.get(key) ?? 0) + 1
		counts.set(key, phase)
		const record = { sessionID, agent, kind, command, phase, body }
		requests.push(record)
		appendFileSync(join(directory, 'requests.jsonl'), `${JSON.stringify(record)}\n`)
		let delta = { content: 'DONE' }
		if (command?.kind === 'dispatch' && phase === 1)
			delta = toolCall('subagent', {
				agent: command.agent ?? 'unit',
				description: `Unit ${command.tag}`,
				prompt: `DIAG:${JSON.stringify(command.child)}`,
				background: command.background ?? true,
				...(command.sessionID ? { sessionID: command.sessionID } : {}),
				...(command.model ? { model: command.model } : {}),
			})
		if (command?.kind === 'unit') {
			if (command.hold) await gate(command.hold).promise
			if (phase === 1 && command.write)
				delta = toolCall('shell', { command: 'pwd; printf "unit-only" > unit-output.txt' })
			else delta = { content: command.answer ?? `Unit result ${command.tag}` }
		}
		if (command?.kind === 'dispatch' && phase > 1 && command.answer)
			delta = { content: command.answer }
		const chunk = (value, finish_reason = null) => ({
			id: 'chatcmpl_fixture',
			object: 'chat.completion.chunk',
			created: 1,
			model: body.model,
			choices: [{ index: 0, delta: value, finish_reason }],
		})
		return new Response(
			`${[chunk({ role: 'assistant' }), chunk(delta), chunk({}, delta.tool_calls ? 'tool_calls' : 'stop')].map((value) => `data: ${JSON.stringify(value)}\n\n`).join('')}data: [DONE]\n\n`,
			{ headers: { 'content-type': 'text/event-stream' } },
		)
	},
})

writeFileSync(join(directory, 'identity', 'package.json'), JSON.stringify({ type: 'module' }))
writeFileSync(
	join(directory, 'identity', 'index.js'),
	`export default {
id:'native-unit-fixture', async setup(ctx) {
  const destination = ctx.location.directory !== ${JSON.stringify(project)};
  if (destination) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await ctx.agent.transform(editor => editor.update('unit', agent => {
    agent.model = destination
      ? {providerID:'fixture',id:'destination',variant:'thorough'}
      : {providerID:'fixture',id:'caller'};
  }));
  await ctx.tool.transform(editor => {
    const native = editor.get('subagent');
    if (!native) return;
    const execute = native.execute;
    editor.update('subagent', tool => {
      tool.execute = (input, context) => execute(input, {
        ...context,
        progress: async update => {
          await context.progress(update);
          const match = /"holdPlacement":"([^"]+)"/.exec(input.prompt);
          if (input.agent === 'unit' && !input.sessionID && update.directory && match) {
            await fetch(${JSON.stringify(provider.url.origin)} + '/placement?tag=' + encodeURIComponent(match[1]), {signal:context.signal});
          }
        },
      });
    });
  });
  await ctx.session.hook('model.request', async event => {
    const info = await ctx.session.get({sessionID:event.sessionID});
    event.headers['x-test-session']=event.sessionID;
    event.headers['x-test-agent']=info.agent;
    event.headers['x-test-kind']=event.kind;
  });
}}`,
)
const model = {
	limit: { context: 1000000, output: 16000 },
	capabilities: { tools: true, input: ['text'], output: ['text'] },
	variants: [{ id: 'thorough', settings: { reasoningEffort: 'high' } }],
}
const rule = (action, effect, resource = '*') => ({ action, resource, effect })
const config = {
	default_agent: 'lead',
	model: 'fixture/lead',
	experimental: { subagent_depth: 3 },
	permissions: [rule('*', 'allow')],
	plugins: ['-opencode.browser', resolve(bundleDirectory), join(directory, 'identity')],
	providers: {
		fixture: {
			package: '@opencode/ai/providers/openai-compatible',
			env: [],
			settings: { baseURL: `${provider.url}v1`, apiKey: 'fixture', transport: 'http' },
			models: { lead: model, caller: model, destination: model, explicit: model },
		},
	},
	agents: {
		lead: { mode: 'primary', model: 'fixture/lead' },
		unit: {
			mode: 'subagent',
			permissions: [
				rule('subagent', 'deny'),
				rule('subagent', 'allow', 'oracle-solve'),
				rule('subagent', 'allow', 'research'),
			],
		},
		'oracle-design': { mode: 'subagent', model: 'fixture/caller' },
		'oracle-solve': { mode: 'subagent', model: 'fixture/caller' },
		research: { mode: 'subagent', model: 'fixture/caller' },
	},
}
writeFileSync(join(directory, 'opencode.json'), JSON.stringify(config))
mkdirSync(join(directory, 'config', 'opencode'), { recursive: true })
writeFileSync(
	join(directory, 'config', 'opencode', 'service.json'),
	JSON.stringify({ password: 'native-unit-fixture' }),
	{ mode: 0o600 },
)
let server
let base
const tasks = []
async function start() {
	server = Bun.spawn(
		[
			resolve(executable),
			'serve',
			'--service',
			'--hostname',
			'127.0.0.1',
			'--port',
			'0',
			'--log-level',
			'debug',
		],
		{
			cwd: project,
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
				OPENCODE_CONFIG: join(directory, 'opencode.json'),
				OPENCODE_CONFIG_DIR: join(directory, 'config', 'opencode'),
				OPENCODE_DISABLE_MODELS_FETCH: '1',
				OPENCODE_DISABLE_FILEWATCHER: '1',
				OPENCODE_DISABLE_FFF: '1',
				OPENCODE_DISABLE_CLAUDE_CODE: '1',
				OPENCODE_PASSWORD: 'native-unit-fixture',
			},
		},
	)
	base = undefined
	for (const [name, stream] of [
		['stdout', server.stdout],
		['stderr', server.stderr],
	])
		tasks.push(
			(async () => {
				let output = ''
				for await (const bytes of stream) {
					const text = new TextDecoder().decode(bytes)
					appendFileSync(join(directory, `${name}.log`), text)
					output += text
					const match = /server listening on (http:\/\/\S+)/.exec(output)
					if (match) base = match[1]
				}
			})(),
		)
	await until(async () => base, Boolean, 'server startup')
	await until(
		async () =>
			(
				await fetch(new URL('/api/info', base), {
					headers: {
						authorization: `Basic ${Buffer.from('opencode:native-unit-fixture').toString('base64')}`,
					},
					signal: AbortSignal.timeout(5000),
				})
			).status,
		(status) => status === 200,
		'managed server readiness',
	)
}
async function stop(signal = 'SIGTERM') {
	server.kill(signal)
	await server.exited
	await Promise.all(tasks.splice(0))
}
async function api(method, path, body) {
	const response = await fetch(new URL(path, base), {
		method,
		headers: {
			authorization: `Basic ${Buffer.from('opencode:native-unit-fixture').toString('base64')}`,
			'content-type': 'application/json',
			'x-opencode-directory': encodeURIComponent(project),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(60_000),
	})
	const text = await response.text()
	assert(response.ok, `${method} ${path}: ${response.status} ${text}`)
	return text ? JSON.parse(text) : undefined
}
const create = async (permissions = [], directory = project) =>
	(
		await api('POST', '/api/session', {
			title: 'Native Unit test',
			agent: 'lead',
			location: { directory },
			permissions,
		})
	).data
const prompt = (id, command) =>
	api('POST', `/api/session/${id}/prompt`, { text: `DIAG:${JSON.stringify(command)}` })
const children = async (parentID) => (await api('GET', `/api/session?parentID=${parentID}`)).data
const context = async (id) => (await api('GET', `/api/session/${id}/context`)).data
const notices = async (id) =>
	(await context(id)).filter(
		(message) => message.type === 'synthetic' && message.metadata?.source === 'subagent',
	)
const waitNotice = (id, count) =>
	until(
		() => notices(id),
		(messages) => messages.length >= count,
		`completion ${count}`,
	)
const pendingPermissions = async (id) => (await api('GET', `/api/session/${id}/permission`)).data
const worktreeCount = () =>
	git('worktree', 'list', '--porcelain')
		.split('\n')
		.filter((line) => line.startsWith('worktree ')).length
async function verify() {
	await start()
	assert.equal((await api('GET', '/api/info')).version, '2.1.4')
	const parent = await create()
	const answer = `Long Unit result: ${'native '.repeat(800)}`
	await prompt(parent.id, {
		kind: 'dispatch',
		tag: 'first',
		child: { kind: 'unit', tag: 'first-child', write: true, answer },
	})
	const [notice] = await waitNotice(parent.id, 1)
	assert(notice.text.includes(answer), 'Full final reply must return to Lead')
	const [child] = await children(parent.id)
	assert(child, 'Native child was created')
	assert.equal(child.parentID, parent.id)
	assert.notEqual(child.location.directory, project)
	assert.equal(readFileSync(join(child.location.directory, 'unit-output.txt'), 'utf8'), 'unit-only')
	assert(!existsSync(join(project, 'unit-output.txt')), 'Unit writes must not affect Lead checkout')
	assert.deepEqual(child.model, { providerID: 'fixture', id: 'destination', variant: 'thorough' })
	const request = requests.find((entry) => entry.sessionID === child.id && entry.kind === 'primary')
	assert.equal(request?.body.model, 'destination')
	assert.equal(request?.body.reasoning_effort, 'high')
	check('native-placement-target-model-and-full-return')
	const unitDelegation = request.body.tools.find((tool) => tool.function.name === 'subagent')
		.function.description
	assert(unitDelegation.includes('- oracle-solve:'))
	assert(unitDelegation.includes('- research:'))
	assert(!unitDelegation.includes('- oracle-design:'))
	assert(!unitDelegation.includes('- unit:'))
	check('unit-technical-support-catalog')

	const subdirectory = await create([], join(project, 'sub'))
	await prompt(subdirectory.id, {
		kind: 'dispatch',
		tag: 'subdirectory',
		child: { kind: 'unit', tag: 'subdirectory-child', write: true },
	})
	await waitNotice(subdirectory.id, 1)
	const [subdirectoryChild] = await children(subdirectory.id)
	assert.equal(
		subdirectoryChild.location.directory,
		join(subdirectoryChild.metadata['limitless.unit'].worktree, 'sub'),
	)
	assert.equal(
		readFileSync(join(subdirectoryChild.location.directory, 'unit-output.txt'), 'utf8'),
		'unit-only',
	)
	assert(!existsSync(join(project, 'sub', 'unit-output.txt')))
	check('subdirectory-placement')

	const missingAtHead = join(project, 'untracked')
	mkdirSync(missingAtHead)
	appendFileSync(join(project, '.git', 'info', 'exclude'), '\nuntracked/\n')
	const untracked = await create([], missingAtHead)
	await prompt(untracked.id, {
		kind: 'dispatch',
		tag: 'untracked-location',
		child: { kind: 'unit', tag: 'untracked-must-not-run' },
	})
	await api('POST', `/api/experimental/session/${untracked.id}/wait`)
	const [missingChild] = await children(untracked.id)
	assert(missingChild)
	assert.equal(missingChild.location.directory, missingAtHead)
	const missingHistory = JSON.stringify(await context(untracked.id))
	assert(missingHistory.includes('Session.DestinationNotFoundError'))
	assert(missingHistory.includes(missingChild.metadata['limitless.unit'].directory))
	assert(!requests.some((entry) => entry.sessionID === missingChild.id))
	const missingCount = worktreeCount()
	await prompt(untracked.id, {
		kind: 'dispatch',
		tag: 'untracked-resume',
		sessionID: missingChild.id,
		child: { kind: 'unit', tag: 'untracked-still-must-not-run' },
	})
	await api('POST', `/api/experimental/session/${untracked.id}/wait`)
	assert(JSON.stringify(await context(untracked.id)).includes('no completed worktree placement'))
	assert.equal(worktreeCount(), missingCount)
	assert(!requests.some((entry) => entry.sessionID === missingChild.id))
	check('missing-head-subdirectory-reports-cause-without-running-unit')

	await prompt(parent.id, {
		kind: 'dispatch',
		tag: 'followup',
		sessionID: child.id,
		child: { kind: 'unit', tag: 'followup-child', answer: 'Follow-up finished' },
	})
	const results = await waitNotice(parent.id, 2)
	assert(results[1].text.includes('Follow-up finished'))
	assert.equal((await children(parent.id)).length, 1)
	assert.equal(
		(await api('GET', `/api/session/${child.id}`)).data.location.directory,
		child.location.directory,
	)
	check('same-child-followup')

	const beforeDenied = worktreeCount()
	const denied = await create([rule('subagent', 'deny', 'unit')])
	await prompt(denied.id, {
		kind: 'dispatch',
		tag: 'denied',
		child: { kind: 'unit', tag: 'denied-child' },
	})
	await api('POST', `/api/experimental/session/${denied.id}/wait`)
	assert.equal((await children(denied.id)).length, 0)
	assert.equal(worktreeCount(), beforeDenied)
	check('denial-before-child-and-worktree')

	for (const decision of ['once', 'reject']) {
		const before = worktreeCount()
		const asking = await create([rule('subagent', 'ask', 'unit')])
		await prompt(asking.id, {
			kind: 'dispatch',
			tag: `approval-${decision}`,
			child: { kind: 'unit', tag: `approved-${decision}` },
		})
		const pending = await until(
			() => pendingPermissions(asking.id),
			(items) => items.length === 1,
			'native approval',
		)
		assert.equal((await children(asking.id)).length, 0)
		assert.equal(worktreeCount(), before)
		await api('POST', `/api/session/${asking.id}/permission/${pending[0].id}/reply`, { decision })
		if (decision === 'once') {
			await waitNotice(asking.id, 1)
			assert.equal(worktreeCount(), before + 1)
			assert.deepEqual(await pendingPermissions(asking.id), [])
		} else {
			await api('POST', `/api/experimental/session/${asking.id}/wait`)
			assert.equal((await children(asking.id)).length, 0)
			assert.equal(worktreeCount(), before)
		}
	}
	check('one-approval-and-decline-before-provisioning')

	const explicit = await create()
	await prompt(explicit.id, {
		kind: 'dispatch',
		tag: 'explicit',
		model: 'fixture/explicit#thorough',
		child: { kind: 'unit', tag: 'explicit-child' },
	})
	await waitNotice(explicit.id, 1)
	const [overridden] = await children(explicit.id)
	assert.deepEqual(overridden.model, { providerID: 'fixture', id: 'explicit', variant: 'thorough' })
	check('explicit-model-override')

	for (const explicitOverride of [false, true]) {
		const tag = `placed-interruption-${explicitOverride}`
		const interrupted = await create()
		await prompt(interrupted.id, {
			kind: 'dispatch',
			tag,
			child: { kind: 'unit', tag: `${tag}-child`, holdPlacement: tag },
		})
		await until(async () => placed.has(tag), Boolean, 'placed child before initial prompt')
		await api('POST', `/api/session/${interrupted.id}/interrupt`, { resume: false })
		gate(tag).release()
		const [uninitialized] = await children(interrupted.id)
		assert.equal(uninitialized.metadata['limitless.unit'].initializeModel, true)
		assert(!requests.some((entry) => entry.sessionID === uninitialized.id))
		const count = worktreeCount()
		await prompt(interrupted.id, {
			kind: 'dispatch',
			tag: `${tag}-continue`,
			sessionID: uninitialized.id,
			...(explicitOverride ? { model: 'fixture/explicit#thorough' } : {}),
			child: { kind: 'unit', tag: `${tag}-continued-child` },
		})
		await waitNotice(interrupted.id, 1)
		assert.equal(worktreeCount(), count)
		const firstRequest = requests.find(
			(entry) => entry.sessionID === uninitialized.id && entry.kind === 'primary',
		)
		assert.equal(firstRequest.body.model, explicitOverride ? 'explicit' : 'destination')
		assert.equal(firstRequest.body.reasoning_effort, 'high')
	}
	check('interrupted-placement-model-continuation')

	const foreground = await create()
	await prompt(foreground.id, {
		kind: 'dispatch',
		tag: 'foreground',
		background: false,
		child: { kind: 'unit', tag: 'foreground-child', hold: 'foreground' },
	})
	await until(
		async () => requests,
		(items) => items.some((item) => item.command?.tag === 'foreground-child'),
		'foreground Unit',
	)
	const [foregroundChild] = await children(foreground.id)
	await api('POST', `/api/session/${foregroundChild.id}/interrupt`, { resume: false })
	gate('foreground').release()
	await api('POST', `/api/experimental/session/${foreground.id}/wait`)
	const foregroundHistory = JSON.stringify(await context(foreground.id))
	assert(foregroundHistory.includes('Subagent cancelled'))
	assert(!foregroundHistory.includes('Unit launch failed'))
	check('native-foreground-cancellation-message')

	const ordinary = await create()
	await prompt(ordinary.id, {
		kind: 'dispatch',
		tag: 'research',
		agent: 'research',
		child: { kind: 'unit', tag: 'research-child' },
	})
	await waitNotice(ordinary.id, 1)
	assert.equal((await children(ordinary.id))[0].location.directory, project)
	check('ordinary-subagents-unchanged')

	const nativeProject = (await api('GET', '/api/project')).find(
		(entry) => entry.canonical === project,
	)
	assert(nativeProject)
	await api('PATCH', `/api/project/${nativeProject.id}`, { commands: { start: 'exit 7' } })
	const failed = await create()
	try {
		await prompt(failed.id, {
			kind: 'dispatch',
			tag: 'setup-failure',
			child: { kind: 'unit', tag: 'must-not-run' },
		})
		await api('POST', `/api/experimental/session/${failed.id}/wait`)
		const [unplaced] = await children(failed.id)
		assert(unplaced, 'Failed setup retains the child for inspection')
		assert.equal(unplaced.location.directory, project)
		const failedHistory = JSON.stringify(await context(failed.id))
		assert(failedHistory.includes(unplaced.id))
		assert(failedHistory.includes('Unit worktree setup failed'))
		assert(failedHistory.includes('Command failed (exit 7)'))
		assert(!requests.some((entry) => entry.sessionID === unplaced.id))
		const beforeRetry = worktreeCount()
		await prompt(failed.id, {
			kind: 'dispatch',
			tag: 'failed-resume',
			sessionID: unplaced.id,
			child: { kind: 'unit', tag: 'still-must-not-run' },
		})
		await api('POST', `/api/experimental/session/${failed.id}/wait`)
		assert.equal(worktreeCount(), beforeRetry)
		assert(JSON.stringify(await context(failed.id)).includes('no completed worktree placement'))
		assert(!requests.some((entry) => entry.sessionID === unplaced.id))
	} finally {
		await api('PATCH', `/api/project/${nativeProject.id}`, { commands: { start: '' } })
	}
	check('setup-failure-keeps-identity-without-running-unit')

	const setupReady = join(directory, 'setup-ready')
	const setupRelease = join(directory, 'setup-release')
	setupReleases.push(setupRelease)
	await api('PATCH', `/api/project/${nativeProject.id}`, {
		commands: {
			start: `pwd > '${setupReady}'; while [ ! -f '${setupRelease}' ]; do sleep 0.05; done`,
		},
	})
	const cancelled = await create()
	try {
		await prompt(cancelled.id, {
			kind: 'dispatch',
			tag: 'cancel-setup',
			child: { kind: 'unit', tag: 'cancelled-must-not-run' },
		})
		await until(async () => existsSync(setupReady), Boolean, 'setup gate')
		await api('POST', `/api/session/${cancelled.id}/interrupt`, { resume: false })
		writeFileSync(setupRelease, 'release')
		await api('POST', `/api/experimental/session/${cancelled.id}/wait`)
		const [cancelledChild] = await children(cancelled.id)
		assert(cancelledChild)
		assert(!requests.some((entry) => entry.sessionID === cancelledChild.id))
		assert.equal((await context(cancelledChild.id)).length, 0)
	} finally {
		writeFileSync(setupRelease, 'release')
		await api('PATCH', `/api/project/${nativeProject.id}`, { commands: { start: '' } })
	}
	check('cancelled-setup-does-not-admit-brief')

	const nested = await create()
	await prompt(nested.id, {
		kind: 'dispatch',
		tag: 'nested-unit',
		child: {
			kind: 'dispatch',
			tag: 'nested-oracle',
			agent: 'oracle-solve',
			background: false,
			answer: 'Unit reviewed',
			child: {
				kind: 'dispatch',
				tag: 'nested-research',
				agent: 'research',
				background: false,
				answer: 'Oracle reviewed',
				child: { kind: 'unit', tag: 'research-evidence', answer: 'Research evidence' },
			},
		},
	})
	assert((await waitNotice(nested.id, 1))[0].text.includes('Unit reviewed'))
	const [nestedUnit] = await children(nested.id)
	const [oracle] = await children(nestedUnit.id)
	const [research] = await children(oracle.id)
	assert.equal(research.agent, 'research')
	assert.equal(oracle.location.directory, nestedUnit.location.directory)
	assert.equal(research.location.directory, nestedUnit.location.directory)
	assert.equal(
		oracle.model.id,
		'caller',
		'Unit model initialization must not leak into descendants',
	)
	check('unit-oracle-research-depth')

	const moved = await create()
	await prompt(moved.id, {
		kind: 'dispatch',
		tag: 'parent-move',
		child: { kind: 'unit', tag: 'held-move', hold: 'move', answer: 'Returned after parent move' },
	})
	await until(
		async () => requests,
		(items) => items.some((item) => item.command?.tag === 'held-move'),
		'held Unit request',
	)
	await api('POST', `/api/experimental/session/${moved.id}/wait`)
	const movedDirectory = join(directory, 'moved-parent')
	mkdirSync(movedDirectory)
	await api('POST', `/api/session/${moved.id}/move`, { directory: movedDirectory })
	await api('POST', `/api/experimental/session/${moved.id}/wait`)
	await api('POST', '/api/location/reload')
	gate('move').release()
	assert((await waitNotice(moved.id, 1))[0].text.includes('Returned after parent move'))
	assert.equal(
		(await api('GET', `/api/session/${moved.id}`)).data.location.directory,
		movedDirectory,
	)
	check('parent-move-and-location-reload')

	// The provider and its response gate survive, but OpenCode's process does not.
	const recovering = await create()
	await prompt(recovering.id, {
		kind: 'dispatch',
		tag: 'restart',
		child: { kind: 'unit', tag: 'held-restart', hold: 'restart', answer: 'Recovered Unit result' },
	})
	await until(
		async () => requests,
		(items) => items.some((item) => item.command?.tag === 'held-restart'),
		'Unit before restart',
	)
	await api('POST', `/api/experimental/session/${recovering.id}/wait`)
	await stop('SIGKILL')
	await start()
	// Like a reconnecting native client, load the session services on the new server.
	await api('GET', '/api/session')
	await until(
		async () => requests,
		(items) => items.filter((item) => item.command?.tag === 'held-restart').length >= 2,
		'native recovered Unit',
	)
	gate('restart').release()
	const recovered = await waitNotice(recovering.id, 1)
	assert.equal(recovered.length, 1)
	assert(recovered[0].text.includes('Recovered Unit result'))
	await api('POST', `/api/experimental/session/${recovering.id}/wait`)
	assert.equal((await notices(recovering.id)).length, 1)
	check('native-restart-and-completion-recovery')
	assert.equal(git('status', '--porcelain'), '')
}
try {
	await verify()
	report.status = 'PASS'
} catch (error) {
	report.status = 'FAIL'
	report.error = error instanceof Error ? error.stack : String(error)
} finally {
	for (const pending of gates.values()) pending.release()
	for (const path of setupReleases) writeFileSync(path, 'release')
	if (server) await stop()
	provider.stop(true)
}
console.log(JSON.stringify(report, null, 2))
if (report.status !== 'PASS') process.exit(1)
