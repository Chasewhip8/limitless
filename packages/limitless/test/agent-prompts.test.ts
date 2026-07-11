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
const skillsDirectory = path.resolve(agentsDirectory, '../../skills')
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
		const key = parseScalar(rawKey.trim())
		if (typeof key !== 'string') throw new Error(`Frontmatter key must be a string: ${line}`)
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

function enabledAgentNamesWithMode(mode: string): Array<string> {
	return enabledAgentNames().filter((agentName) => readAgentFrontmatter(agentName).mode === mode)
}

function enabledPrimaryAgentNames(): Array<string> {
	return enabledAgentNamesWithMode('primary')
}

function enabledSubagentNames(): Array<string> {
	return enabledAgentNamesWithMode('subagent')
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

const retiredGitHubToolNames = [
	'github_code_search',
	'github_file_read',
	'github_repo_tree',
] as const

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

	test('primary agents have expected subagent task permissions', () => {
		const expectedSubagents = enabledSubagentNames()

		for (const agentName of enabledPrimaryAgentNames()) {
			const task = requireObject(permissionFor(agentName).task, `${agentName} task permission`)

			expect(Object.keys(task).sort((left, right) => left.localeCompare(right))).toEqual(
				expectedSubagents,
			)
			for (const subagent of expectedSubagents) {
				expect(task[subagent]).toBe('allow')
			}
		}
	})

	test('research denies edit and inherits bash access', () => {
		const permission = permissionFor('research')
		expect(permission.edit).toBe('deny')
		expect(permission.bash).toBeUndefined()
	})

	test('all enabled agents inherit bash access', () => {
		for (const agentName of enabledAgentNames()) {
			expect(permissionFor(agentName).bash, agentName).not.toBe('deny')
		}
	})

	test('research denies mutating custom tools', () => {
		const mutatingCustomTools = ['artifact_create', 'ast_grep_replace', 'typst_compile']
		const permission = permissionFor('research')
		for (const toolName of mutatingCustomTools) {
			expect(permission[toolName], toolName).toBe('deny')
		}
	})

	test('all agents inherit github_clone access without overriding top-level policy', () => {
		for (const agentName of enabledAgentNames()) {
			const permission = permissionFor(agentName)
			expect(permission.github_clone, `${agentName} github_clone`).not.toBe('deny')
			for (const toolName of retiredGitHubToolNames) {
				expect(permission[toolName], `${agentName} ${toolName}`).toBeUndefined()
			}
		}
	})
})

describe('oracle prompt', () => {
	test('oracle.md replaces advisor.md', () => {
		expect(agentFiles).toContain('oracle.md')
		expect(agentFiles).not.toContain('advisor.md')
	})

	test('oracle denies normal edit tools and otherwise inherits broad access', () => {
		const frontmatter = readAgentFrontmatter('oracle')
		const permission = permissionFor('oracle')
		const task = requireObject(permission.task, 'oracle task permission')

		expect(frontmatter.mode).toBe('subagent')
		expect(frontmatter.hidden).toBe(true)
		expect(frontmatter.model).toBe('openai/gpt-5.6-sol-pro')
		expect(frontmatter.model).not.toBe(readAgentFrontmatter('limitless').model)
		expect(frontmatter.reasoningEffort).toBe('max')
		expect(permission.edit).toBe('deny')
		expect(permission.ast_grep_replace).toBe('deny')
		expect(permission['*']).toBeUndefined()
		expect(permission.bash).toBeUndefined()
		expect(permission.artifact_create).toBeUndefined()
		expect(permission.typst_compile).toBeUndefined()
		expect(task.research).toBe('allow')
	})

	test('implementation agents can task research', () => {
		for (const agentName of ['engineer', 'frontend']) {
			expectCanTask(agentName, 'research')
		}
	})

	test('oracle task routing is limited to primary agents', () => {
		for (const agentName of enabledPrimaryAgentNames()) {
			expectCanTask(agentName, 'oracle')
		}
		expectCannotTask('review', 'oracle')
		expectCannotTask('engineer', 'oracle')
		expectCannotTask('frontend', 'oracle')
	})

	test('strategy subagent is removed so planning stays in primary context', () => {
		expect(agentFiles).not.toContain('strategy.md')
		for (const agentName of enabledPrimaryAgentNames()) {
			expect(taskPermissionFor(agentName)?.strategy, agentName).not.toBe('allow')
		}
	})

	test('critique.md does not exist, or is explicitly marked deprecated', () => {
		const critiquePath = path.join(agentsDirectory, 'critique.md')
		if (existsSync(critiquePath)) {
			expect(readFileSync(critiquePath, 'utf8')).toMatch(/deprecated/i)
		} else {
			expect(agentFiles).not.toContain('critique.md')
		}
	})

	test('oracle prompt includes required answer fields', () => {
		const content = readAgentContent('oracle')
		for (const field of ['<answer>', '<recommendation>', '<tradeoffs>', '<evidence>', '<gaps>']) {
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
		expect(permission.bash).toBeUndefined()
		expect(permission.webfetch).toBe('allow')
		expect(permission.github_clone).toBeUndefined()
		expect(readAgentContent('research')).toContain('call `github_clone` first')
	})

	test('research task routing includes callers that need evidence', () => {
		for (const agentName of enabledPrimaryAgentNames()) {
			expectCanTask(agentName, 'research')
		}
		expectCanTask('oracle', 'research')
		expectCanTask('engineer', 'research')
		expectCanTask('frontend', 'research')
		expectCanTask('review', 'research')
	})
})

describe('review prompt', () => {
	test('review is a skill-based review-and-fix agent', () => {
		const frontmatter = readAgentFrontmatter('review')
		const permission = permissionFor('review')
		const content = readAgentContent('review')

		expect(frontmatter.description).toContain('review-and-fix')
		const edit = requireObject(permission.edit, 'review edit permission')
		expect(edit['*']).toBe('allow')
		expect(edit['.limitless/repos']).toBe('deny')
		expect(edit['.limitless/repos/**']).toBe('deny')
		expect(permission.ast_grep_replace).toBe('allow')
		expect(content).toContain('Every pass must be based on at least one named review skill')
		expect(content).toContain('<fixed_issues>')
		expect(content).toContain('<unfixed_issues>')
	})

	test('review-general ships deterministic baseline rules', () => {
		const content = readFileSync(path.join(skillsDirectory, 'review-general/SKILL.md'), 'utf8')
		expect(content).toContain('name: review-general')
		for (const rule of ['GEN-01', 'GEN-02', 'GEN-03', 'GEN-04', 'GEN-05']) {
			expect(content).toContain(rule)
		}
		expect(content).toContain('Do not invent style rules')
	})
})
