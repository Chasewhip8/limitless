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

const executionAgents = ['limitless', 'limitless-fast', 'solo', 'worker']
const readOnlyAgents = ['research', 'oracle-solve', 'oracle-design']
const sharedActions = [
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
const writeActions = [
	'shell',
	'edit',
	'artifact_create',
	'ast_grep_replace',
	'opencode_session_move',
	'opencode_session_rename',
]

for (const file of files) {
	const input = JSON.parse(await readFile(file, 'utf8'))
	Schema.decodeUnknownSync(Config.Info)(input, { onExcessProperty: 'error' })
	for (const name of [...executionAgents, ...readOnlyAgents]) {
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
		for (const action of writeActions) {
			expectEffect(action, '*', readOnlyAgents.includes(name) ? 'deny' : 'allow')
		}
		for (const resource of [
			'~/.ssh/id_ed25519',
			'$HOME/.aws/credentials',
			'~/.gnupg/private.key',
			'~/.config/gh/hosts.yml',
			'.env',
		]) {
			expectEffect('read', resource, 'allow')
		}
		for (const command of [
			'git reset --hard',
			'git push --force',
			'rm -rf build',
			'sudo command',
			'npm publish',
			'terraform destroy',
		]) {
			expectEffect('shell', command, readOnlyAgents.includes(name) ? 'deny' : 'allow')
		}
		for (const server of Object.keys(input.mcp.servers)) {
			expectEffect(`${server}_unknown-tool`, '*', readOnlyAgents.includes(name) ? 'deny' : 'allow')
		}
		expectEffect('edit', '.limitless/repos/example/file.ts', 'deny')
		expectEffect('browser', '*', 'deny')
	}
	console.log(`Validated ${file} and packaged agent permissions against the pinned OpenCode schema`)
}
