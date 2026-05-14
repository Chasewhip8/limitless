import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

type FrontmatterValue = boolean | string | FrontmatterObject
type FrontmatterObject = { [key: string]: FrontmatterValue }
type FrontmatterStackItem = { readonly indent: number; readonly object: FrontmatterObject }

const agentsDirectory = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../opencode/agents',
)
const agentFiles = readdirSync(agentsDirectory)
	.filter((fileName) => fileName.endsWith('.md'))
	.sort((left, right) => left.localeCompare(right))

function lastStackItem(stack: ReadonlyArray<FrontmatterStackItem>): FrontmatterStackItem {
	const item = stack[stack.length - 1]
	if (item === undefined) throw new Error('Frontmatter parser stack is empty.')
	return item
}

function parseScalar(value: string): boolean | string {
	if (value === 'true') return true
	if (value === 'false') return false

	const first = value[0]
	const last = value[value.length - 1]
	if (value.length >= 2 && first === last && (first === '"' || first === "'")) {
		return value.slice(1, -1)
	}
	return value
}

function parseFrontmatter(content: string): FrontmatterObject {
	const lines = content.split(/\r\n|\r|\n/u)
	if (lines[0] !== '---') throw new Error('Missing opening frontmatter delimiter.')

	const end = lines.indexOf('---', 1)
	if (end === -1) throw new Error('Missing closing frontmatter delimiter.')

	const root: FrontmatterObject = {}
	const stack: Array<FrontmatterStackItem> = [{ indent: -1, object: root }]

	for (const line of lines.slice(1, end)) {
		if (line.trim().length === 0) continue
		const match = /^( *)([^:]+):(.*)$/u.exec(line)
		if (match === null) throw new Error(`Unsupported frontmatter line: ${line}`)
		const leadingWhitespace = match[1]
		const rawKey = match[2]
		const rawValue = match[3]
		if (leadingWhitespace === undefined || rawKey === undefined || rawValue === undefined) {
			throw new Error(`Malformed frontmatter line: ${line}`)
		}

		const indent = leadingWhitespace.length
		const key = rawKey.trim()
		const value = rawValue.trim()
		while (stack.length > 1 && indent <= lastStackItem(stack).indent) stack.pop()

		const parent = lastStackItem(stack).object
		if (value.length === 0) {
			const child: FrontmatterObject = {}
			parent[key] = child
			stack.push({ indent, object: child })
		} else {
			parent[key] = parseScalar(value)
		}
	}

	return root
}

function readAgentContent(agentName: string): string {
	return readFileSync(path.join(agentsDirectory, `${agentName}.md`), 'utf8')
}

function readAgentFrontmatter(agentName: string): FrontmatterObject {
	return parseFrontmatter(readAgentContent(agentName))
}

function enabledAgentNames(): Array<string> {
	return agentFiles
		.map((fileName) => path.basename(fileName, '.md'))
		.filter((agentName) => readAgentFrontmatter(agentName).disable !== true)
		.sort((left, right) => left.localeCompare(right))
}

function requireObject(value: FrontmatterValue | undefined, label: string): FrontmatterObject {
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value
	throw new Error(`${label} must be an object.`)
}

function permissionFor(agentName: string): FrontmatterObject {
	return requireObject(readAgentFrontmatter(agentName).permission, `${agentName} permission`)
}

function taskPermissionFor(agentName: string): FrontmatterObject | undefined {
	const task = permissionFor(agentName).task
	if (task === undefined) return undefined
	return requireObject(task, `${agentName} task permission`)
}

function expectCanTask(agentName: string, subagentName: string): void {
	expect(taskPermissionFor(agentName)?.[subagentName], `${agentName} -> ${subagentName}`).toBe(
		'allow',
	)
}

function expectCannotTask(agentName: string, subagentName: string): void {
	expect(taskPermissionFor(agentName)?.[subagentName], `${agentName} -> ${subagentName}`).not.toBe(
		'allow',
	)
}

const githubToolNames = ['github_code_search', 'github_file_read', 'github_repo_tree'] as const

describe('agent prompt frontmatter', () => {
	test('all agent markdown frontmatter parses', () => {
		expect(agentFiles.length).toBeGreaterThan(0)
		for (const fileName of agentFiles) {
			const content = readFileSync(path.join(agentsDirectory, fileName), 'utf8')
			const frontmatter = parseFrontmatter(content)
			expect(frontmatter.description, fileName).toEqual(expect.any(String))
			expect(frontmatter.mode, fileName).toEqual(expect.any(String))
			if (frontmatter.disable === true) continue
			expect(frontmatter.model, fileName).toEqual(expect.any(String))
			expect(frontmatter.permission, fileName).toEqual(expect.any(Object))
		}
	})

	test('primary has expected subagent task permissions', () => {
		const task = requireObject(permissionFor('limitless').task, 'limitless task permission')
		const expectedSubagents = enabledAgentNames().filter((agentName) => agentName !== 'limitless')

		expect(Object.keys(task).sort((left, right) => left.localeCompare(right))).toEqual(
			expectedSubagents,
		)
		for (const subagent of expectedSubagents) {
			expect(task[subagent]).toBe('allow')
		}
	})

	test('read-only agents deny edit/bash', () => {
		const readOnlyAgents = ['advisor', 'research', 'review']
		for (const agentName of readOnlyAgents) {
			const permission = permissionFor(agentName)
			expect(permission.edit, agentName).toBe('deny')
			expect(permission.bash, agentName).toBe('deny')
		}
	})

	test('mutating custom tools are not allowed for read-only agents', () => {
		const readOnlyAgents = ['advisor', 'research', 'review']
		const mutatingCustomTools = ['ast_grep_replace']

		for (const agentName of readOnlyAgents) {
			const permission = permissionFor(agentName)
			for (const toolName of mutatingCustomTools) {
				expect(permission[toolName], `${agentName} ${toolName}`).toBe('deny')
			}
		}
	})

	test('GitHub tools are isolated to research', () => {
		const nonGitHubAgents = enabledAgentNames().filter((agentName) => agentName !== 'research')

		for (const agentName of nonGitHubAgents) {
			const permission = permissionFor(agentName)
			for (const toolName of githubToolNames) {
				expect(permission[toolName], `${agentName} ${toolName}`).toBe('deny')
			}
		}

		const researchPermission = permissionFor('research')
		for (const toolName of githubToolNames) {
			expect(researchPermission[toolName], `research ${toolName}`).toBe('allow')
		}
	})
})

describe('advisor prompt', () => {
	test('advisor.md exists', () => {
		expect(agentFiles).toContain('advisor.md')
	})

	test('advisor frontmatter matches role and permissions', () => {
		const frontmatter = readAgentFrontmatter('advisor')
		const permission = permissionFor('advisor')
		const task = requireObject(permission.task, 'advisor task permission')

		expect(frontmatter.mode).toBe('subagent')
		expect(frontmatter.hidden).toBe(true)
		expect(frontmatter.model).toBe('anthropic/claude-opus-4-7')
		expect(frontmatter.model).not.toBe(readAgentFrontmatter('limitless').model)
		expect(permission.edit).toBe('deny')
		expect(permission.bash).toBe('deny')
		expect(permission.webfetch).toBe('deny')
		expect(task.research).toBe('allow')
	})

	test('implementation agents can task research', () => {
		for (const agentName of ['engineer', 'frontend']) {
			expectCanTask(agentName, 'research')
		}
	})

	test('advisor task routing is limited to primary and review roles', () => {
		expectCanTask('limitless', 'advisor')
		expectCanTask('review', 'advisor')
		expectCannotTask('engineer', 'advisor')
		expectCannotTask('frontend', 'advisor')
	})

	test('strategy subagent is removed so planning stays in primary context', () => {
		expect(agentFiles).not.toContain('strategy.md')
		expect(taskPermissionFor('limitless')?.strategy).not.toBe('allow')
	})

	test('critique.md does not exist, or is explicitly marked deprecated', () => {
		const critiquePath = path.join(agentsDirectory, 'critique.md')
		if (existsSync(critiquePath)) {
			expect(readFileSync(critiquePath, 'utf8')).toMatch(/deprecated/i)
		} else {
			expect(agentFiles).not.toContain('critique.md')
		}
	})

	test('advisor prompt includes required return fields', () => {
		const content = readAgentContent('advisor')
		for (const field of [
			'<judgment>',
			'<strongest_objection>',
			'<alternatives>',
			'<recommended_next_step>',
			'<gaps>',
		]) {
			expect(content).toContain(field)
		}
	})
})

describe('research prompt', () => {
	test('research.md replaces split local and external research agents', () => {
		expect(agentFiles).toContain('research.md')
		expect(agentFiles).not.toContain('librarian.md')
		expect(agentFiles).not.toContain('web-librarian.md')
		expect(agentFiles).not.toContain('code-librarian.md')
	})

	test('explore.md disables the built-in split local research agent', () => {
		expect(agentFiles).toContain('explore.md')
		expect(readAgentFrontmatter('explore').disable).toBe(true)
	})

	test('research frontmatter matches role and permissions', () => {
		const frontmatter = readAgentFrontmatter('research')
		const permission = permissionFor('research')

		expect(frontmatter.mode).toBe('subagent')
		expect(permission.edit).toBe('deny')
		expect(permission.bash).toBe('deny')
		expect(permission.webfetch).toBe('allow')
		expect(permission.github_code_search).toBe('allow')
		expect(permission.github_file_read).toBe('allow')
		expect(permission.github_repo_tree).toBe('allow')
	})

	test('research task routing includes callers that need evidence', () => {
		expectCanTask('limitless', 'research')
		expectCanTask('advisor', 'research')
		expectCanTask('engineer', 'research')
		expectCanTask('frontend', 'research')
		expectCanTask('review', 'research')
	})
})
