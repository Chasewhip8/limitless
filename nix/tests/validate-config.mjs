import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Config } from '@opencode/schema/config'
import { YAML } from 'bun'
import { Schema } from 'effect'

const [agentsDirectory, ...files] = process.argv.slice(2)
assert(
	agentsDirectory && files.length > 0,
	'Pass an agent directory and generated OpenCode configurations',
)

const agents = {}
for (const file of await readdir(agentsDirectory)) {
	if (!file.endsWith('.md')) continue
	const contents = await readFile(join(agentsDirectory, file), 'utf8')
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents)
	assert(frontmatter, `Missing agent frontmatter: ${file}`)
	agents[basename(file, '.md')] = YAML.parse(frontmatter[1])
}
Schema.decodeUnknownSync(Config.Info)({ agents }, { onExcessProperty: 'error' })
assert.equal(agents.limitless?.model, 'openai/gpt-6-astra#xhigh')
// Paseo offers only visible primary agents as modes and rejects any other
// modeId, so Lead can create units only while `unit` is one.
for (const name of ['limitless', 'lead', 'unit']) {
	assert.equal(agents[name]?.mode, 'primary', `${name} must be a selectable primary agent`)
	assert.notEqual(agents[name]?.hidden, true, `${name} must be a visible Paseo mode`)
}

function matches(pattern, value) {
	const expression = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replaceAll('*', '.*')
		.replaceAll('?', '.')
	return new RegExp(`^${expression}$`).test(value)
}

function effectFor(rules, action, resource) {
	let effect = 'ask'
	for (const rule of rules) {
		if (matches(rule.action, action) && matches(rule.resource, resource)) effect = rule.effect
	}
	return effect
}

const primaryAgents = ['limitless', 'lead', 'unit']
const supportAgents = ['research', 'oracle-solve', 'oracle-design']
const sharedActions = [
	'shell',
	'edit',
	'read',
	'glob',
	'grep',
	'webfetch',
	'websearch',
	'skill',
	'execute',
	'external_directory',
	'artifact_list',
	'ast_grep_search',
	'ast_grep_replace',
	'github_clone',
	'lsp_diagnostics',
	'lsp_definition',
	'lsp_hover',
	'lsp_implementation',
	'lsp_call_hierarchy',
	'lsp_references',
	'lsp_symbols',
	'lsp_rename',
	'opencode_models',
]
const primaryOnlyActions = ['artifact_create', 'opencode_session_move', 'opencode_session_rename']
const unitPaseoTools = [
	'send_agent_prompt',
	'get_agent_status',
	'get_agent_activity',
	'list_agents',
	'create_heartbeat',
	'delete_heartbeat',
	'list_schedules',
	'list_workspace_scripts',
	'start_workspace_script',
	'stop_workspace_script',
	'list_terminals',
	'create_terminal',
	'kill_terminal',
	'capture_terminal',
	'send_terminal_keys',
]
const unitDeniedPaseoTools = [
	'create_agent',
	'create_workspace',
	'archive_workspace',
	'cancel_agent',
	'archive_agent',
	'kill_agent',
	'update_agent',
	'set_agent_mode',
	'create_schedule',
	'run_schedule_once',
	'respond_to_permission',
]

for (const file of files) {
	const input = JSON.parse(await readFile(file, 'utf8'))
	Schema.decodeUnknownSync(Config.Info)(input, { onExcessProperty: 'error' })
	const browserRemoval = input.plugins.lastIndexOf('-opencode.browser')
	assert(browserRemoval >= 0, `${file}: the native browser plugin must be disabled`)
	assert(
		!input.plugins
			.slice(browserRemoval + 1)
			.some((entry) => ['*', 'opencode.*', 'opencode.browser'].includes(entry)),
		`${file}: later plugin directives must not re-enable the native browser`,
	)
	assert.equal(
		input.providers?.openai?.settings?.compaction?.type,
		'native',
		`${file}: OpenAI models must default to native compaction`,
	)
	for (const name of [...primaryAgents, ...supportAgents]) {
		assert(agents[name], `Missing packaged agent: ${name}`)
		const rules = [
			...input.permissions,
			...(input.agents?.[name]?.permissions ?? []),
			...(agents[name].permissions ?? []),
		]
		const expectEffect = (action, resource, effect) => {
			assert.equal(
				effectFor(rules, action, resource),
				effect,
				`${file}: ${name} ${action} ${resource}`,
			)
		}
		for (const action of sharedActions) expectEffect(action, '*', 'allow')
		expectEffect('t3-code-thread_preview_open', '*', 'deny')
		expectEffect('t3-code-thread_delegate_task', '*', 'deny')
		for (const action of primaryOnlyActions) {
			expectEffect(action, '*', supportAgents.includes(name) ? 'deny' : 'allow')
		}
		for (const resource of [
			'src/example.ts',
			'test/smoke.test.ts',
			'/home/test/src/example.ts',
			'/tmp/opencode/diagnosis/repro.ts',
		]) {
			expectEffect('edit', resource, 'allow')
		}
		expectEffect('shell', 'bun run test', 'allow')
		for (const server of Object.keys(input.mcp.servers)) {
			const allowed = server === 'executor-read' ? name === 'research' : name !== 'research'
			expectEffect(`${server}_unknown-tool`, '*', allowed ? 'allow' : 'deny')
			if (server === 'executor' || server === 'executor-read') {
				for (const tool of ['skills', 'search', 'describe', 'call', 'execute', 'resume']) {
					expectEffect(`${server}_${tool}`, '*', allowed ? 'allow' : 'deny')
				}
			}
		}
		if (name === 'lead') {
			for (const agent of supportAgents) expectEffect('subagent', agent, 'allow')
		}
		if (name === 'unit') {
			expectEffect('subagent', 'oracle-solve', 'allow')
			expectEffect('subagent', 'research', 'allow')
			expectEffect('subagent', 'oracle-design', 'deny')
			expectEffect('subagent', 'unknown-agent', 'deny')
		}
		// Paseo tools: everything for limitless and lead, an allowlist for units
		// (Paseo checks no ownership), and none for support agents.
		const paseoEffect = (tool) => {
			if (supportAgents.includes(name)) return 'deny'
			if (name !== 'unit') return 'allow'
			return unitPaseoTools.includes(tool) || tool.startsWith('browser_') ? 'allow' : 'deny'
		}
		for (const tool of [
			...unitPaseoTools,
			...unitDeniedPaseoTools,
			'browser_snapshot',
			'future_tool',
		])
			expectEffect(`paseo_${tool}`, '*', paseoEffect(tool))
		if (supportAgents.includes(name)) {
			expectEffect('question', '*', 'deny')
			expectEffect('subagent', 'research', name === 'research' ? 'deny' : 'allow')
			expectEffect('subagent', 'oracle-solve', 'deny')
			expectEffect('subagent', 'oracle-design', 'deny')
		}
		expectEffect('edit', '.limitless/repos/example/file.ts', 'deny')
	}
	console.log(`Validated ${file} and packaged agent permissions against the pinned OpenCode schema`)
}
