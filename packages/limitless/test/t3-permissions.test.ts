import type { Permission } from '@opencode/schema/permission'
import { describe, expect, test } from 'vitest'
import {
	canonicalT3Namespace,
	hasT3Permissions,
	normalizeT3Permissions,
	ownT3Namespace,
	samePermissionRules,
	T3_BROWSER_TOOLS,
} from '../t3/permissions'
import toolNames from './fixtures/t3-tool-names.json'

const supportAgents = ['research', 'oracle-solve', 'oracle-design']
const namespaces = [
	't3-code-35ce915b-46a3-4496-9544-eaf1261c948d',
	't3-code-thread_x',
	't3-code-_x',
	't3-code-0123456789abcdef',
]
const nativeDefaults: Permission.Ruleset = [{ action: '*', resource: '*', effect: 'allow' }]

function t3Rules(namespace: string): Permission.Rule[] {
	return [
		{ action: '*', resource: '*', effect: 'allow' },
		{ action: 't3-code-*', resource: '*', effect: 'deny' },
		{ action: `${namespace}_*`, resource: '*', effect: 'allow' },
	]
}

function matches(pattern: string, value: string): boolean {
	const expression = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replaceAll('*', '.*')
		.replaceAll('?', '.')
	return new RegExp(`^${expression}$`).test(value)
}

function effectFor(rules: Permission.Ruleset, action: string, resource = '*') {
	return (
		[...rules]
			.reverse()
			.find((entry) => matches(entry.action, action) && matches(entry.resource, resource))
			?.effect ?? 'ask'
	)
}

describe.each(namespaces)('T3 session rules for %s', (sourceNamespace) => {
	const namespace = canonicalT3Namespace(sourceNamespace)
	test('retains 78 primary tools and denies delegation and HTML visual tools', () => {
		const rules = [
			...nativeDefaults,
			...normalizeT3Permissions(t3Rules(sourceNamespace), 'limitless'),
		]
		expect(toolNames).toHaveLength(83)
		expect(effectFor(rules, `${namespace}_extra_delegate_task`)).toBe('allow')
		expect(toolNames.filter((name) => effectFor(rules, `${namespace}_${name}`) === 'deny')).toEqual(
			['delegate_task', 'html_preview', 'html_render', 'task_cancel', 'task_status'],
		)
	})

	test.each([
		'limitless',
		...supportAgents,
	])('denies HTML visuals despite explicit grants for %s', (agent) => {
		const rules = [
			...nativeDefaults,
			...normalizeT3Permissions(
				[
					...t3Rules(sourceNamespace),
					...['t3-code', sourceNamespace].flatMap((server) =>
						['html_preview', 'html_render'].map((name) => ({
							action: `${server}_${name}`,
							resource: '*',
							effect: 'allow' as const,
						})),
					),
				],
				agent,
			),
		]
		for (const server of ['t3-code', namespace]) {
			for (const name of ['html_preview', 'html_render']) {
				expect(effectFor(rules, `${server}_${name}`)).toBe('deny')
			}
		}
	})

	test.each(supportAgents)('exposes only the 21 browser tools to %s', (agent) => {
		const rules = [...nativeDefaults, ...normalizeT3Permissions(t3Rules(sourceNamespace), agent)]
		expect(T3_BROWSER_TOOLS).toHaveLength(21)
		expect(
			toolNames.filter((name) => effectFor(rules, `${namespace}_${name}`) === 'allow'),
		).toEqual([...T3_BROWSER_TOOLS])
		for (const name of [...toolNames, 'future_tool', 'preview_future_tool']) {
			expect(effectFor(rules, `t3-code-sibling_${name}`)).toBe('deny')
		}
		for (const name of ['future_tool', 'preview_future_tool', 'extra_preview_click']) {
			expect(effectFor(rules, `${namespace}_${name}`)).toBe('deny')
		}
	})

	test('replaces an inherited primary or support policy without accumulating rules', () => {
		const primary = normalizeT3Permissions(t3Rules(sourceNamespace), 'limitless')
		const child = normalizeT3Permissions(primary, 'research')
		expect(normalizeT3Permissions(child, 'oracle-design')).toEqual(child)
		expect(normalizeT3Permissions(child, 'research')).toEqual(child)
		expect(normalizeT3Permissions(child, 'limitless')).toEqual(primary)
		expect(ownT3Namespace(child)).toBe(namespace)
		expect(hasT3Permissions(child)).toBe(true)
	})
})

test('preserves operator asks, plan restrictions, grants, paths, and unrelated role restrictions', () => {
	const namespace = namespaces[0]
	if (namespace === undefined) throw new Error('Missing namespace fixture')
	const modeRules: Permission.Rule[] = [
		{ action: 'shell', resource: '*', effect: 'ask' },
		{ action: 'shell', resource: 'bun test', effect: 'allow' },
		{ action: 'edit', resource: '*', effect: 'deny' },
		{ action: 'edit', resource: '/plans/*', effect: 'allow' },
	]
	const input = [...modeRules, ...t3Rules(namespace)]
	const output = normalizeT3Permissions(input, 'research')
	const roleRules: Permission.Rule[] = [
		...nativeDefaults,
		{ action: 'question', resource: '*', effect: 'deny' },
		{ action: 'subagent', resource: '*', effect: 'deny' },
		{ action: 'notion_*', resource: '*', effect: 'deny' },
		{ action: 'notion_fetch', resource: '*', effect: 'allow' },
	]
	expect(output.slice(0, modeRules.length)).toEqual(modeRules)
	expect(input).toEqual([...modeRules, ...t3Rules(namespace)])
	const effective = [...roleRules, ...output]
	expect(effectFor(effective, 'shell', 'bun test')).toBe('allow')
	expect(effectFor(effective, 'shell', 'git status')).toBe('ask')
	expect(effectFor(effective, 'edit', '/plans/task.md')).toBe('allow')
	expect(effectFor(effective, 'edit', '/src/main.ts')).toBe('deny')
	expect(effectFor(effective, 'question')).toBe('deny')
	expect(effectFor(effective, 'subagent', 'research')).toBe('deny')
	expect(effectFor(effective, 'notion_fetch')).toBe('allow')
	expect(effectFor(effective, 'notion_write')).toBe('deny')
})

test('an unbound T3 session cannot see another thread namespace', () => {
	const rules = [...nativeDefaults, ...normalizeT3Permissions(nativeDefaults, 'limitless')]
	expect(effectFor(rules, 't3-code-sibling_preview_open')).toBe('deny')
	expect(effectFor(rules, 'shell')).toBe('allow')
	expect(ownT3Namespace(rules)).toBeUndefined()
})

test('prefix-related thread IDs become isolated namespaces without restricting future primary tools', () => {
	const own = 't3-code-parent'
	const sibling = canonicalT3Namespace('t3-code-parent_child')
	const rules = [...nativeDefaults, ...normalizeT3Permissions(t3Rules(own), 'limitless')]
	expect(sibling.includes('_')).toBe(false)
	for (const name of toolNames) expect(effectFor(rules, `${sibling}_${name}`)).toBe('deny')
	expect(effectFor(rules, `${own}_future_tool`)).toBe('allow')
	expect(canonicalT3Namespace(sibling)).toBe(sibling)
})

test('rejects malformed or conflicting namespace anchors rather than guessing', () => {
	expect(() =>
		normalizeT3Permissions([...t3Rules('t3-code-one'), ...t3Rules('t3-code-two')], 'limitless'),
	).toThrow('Ambiguous')
	expect(() => normalizeT3Permissions(t3Rules('t3-code-bad/name'), 'limitless')).toThrow('Invalid')
	expect(() => normalizeT3Permissions(t3Rules(`t3-code-${'a'.repeat(57)}`), 'research')).toThrow(
		'Invalid',
	)
})

test('semantic equality ignores object key order but not rule order', () => {
	expect(
		samePermissionRules(
			[{ action: 'read', resource: '*', effect: 'allow' }],
			[{ effect: 'allow', resource: '*', action: 'read' }],
		),
	).toBe(true)
	expect(samePermissionRules(t3Rules('t3-code-one'), [...t3Rules('t3-code-one')].reverse())).toBe(
		false,
	)
})
