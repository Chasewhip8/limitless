import { createHash } from 'node:crypto'
import type { Permission } from '@opencode/schema/permission'
import { Schema } from 'effect'

export class T3PermissionError extends Schema.TaggedError<T3PermissionError>()(
	'T3PermissionError',
	{
		message: Schema.String,
	},
) {}

const supportAgents = new Set(['research', 'oracle-solve', 'oracle-design'])
export const isT3SupportAgent = (agent: string | undefined) =>
	agent !== undefined && supportAgents.has(agent)
const disabledTools = ['delegate_task', 'task_status', 'task_cancel', 'html_preview', 'html_render']

function rule(action: string, effect: Permission.Effect): Permission.Rule {
	return { action, resource: '*', effect }
}

const isolationRule = rule('t3-code-*', 'deny')

function sameRule(left: Permission.Rule, right: Permission.Rule): boolean {
	return (
		left.action === right.action && left.resource === right.resource && left.effect === right.effect
	)
}

export function samePermissionRules(left: Permission.Ruleset, right: Permission.Ruleset): boolean {
	return (
		left.length === right.length &&
		left.every((entry, index) => {
			const other = right[index]
			return other !== undefined && sameRule(entry, other)
		})
	)
}

export function hasT3Permissions(permissions: Permission.Ruleset): boolean {
	return permissions.some((entry) => sameRule(entry, isolationRule))
}

export function canonicalT3Namespace(namespace: string): string {
	// An underscore is also OpenCode's server/tool separator. Hash only ambiguous
	// names so an own-server wildcard cannot grant another thread's tools.
	return namespace.startsWith('t3-code-') && namespace.includes('_')
		? `t3-code-${createHash('sha256').update(namespace).digest('hex').slice(0, 32)}`
		: namespace
}

function namespaceAliases(permissions: Permission.Ruleset): Map<string, string> {
	const aliases = new Map<string, string>()
	for (let index = 0; index < permissions.length - 1; index++) {
		const entry = permissions[index]
		const next = permissions[index + 1]
		if (entry === undefined || next === undefined || !sameRule(entry, isolationRule)) continue
		if (next.effect !== 'allow' || next.resource !== '*') continue
		const namespace = /^(t3-code-[A-Za-z0-9_-]{1,56})_\*$/.exec(next.action)?.[1]
		if (namespace === undefined)
			throw new T3PermissionError({ message: 'Invalid T3 thread namespace permission' })
		aliases.set(namespace, canonicalT3Namespace(namespace))
	}
	if (new Set(aliases.values()).size > 1)
		throw new T3PermissionError({ message: 'Ambiguous T3 thread namespace permissions' })
	return aliases
}

function canonicalizeT3Permissions(permissions: Permission.Ruleset): Permission.Ruleset {
	const aliases = namespaceAliases(permissions)
	return permissions.map((entry) => {
		for (const [source, target] of aliases) {
			if (source !== target && entry.action.startsWith(`${source}_`)) {
				return { ...entry, action: `${target}${entry.action.slice(source.length)}` }
			}
		}
		return entry
	})
}

export function ownT3Namespace(permissions: Permission.Ruleset): string | undefined {
	return namespaceAliases(permissions).values().next().value
}

function managedRules(namespace: string | undefined, support: boolean): Permission.Rule[] {
	return [
		isolationRule,
		...(namespace === undefined
			? []
			: [
					// Preserve the binding anchor even when the role denies its tools.
					rule(`${namespace}_*`, 'allow'),
					...(support ? [rule(`${namespace}_*`, 'deny')] : []),
				]),
		...(support ? [rule('t3-code_*', 'deny')] : []),
		...disabledTools.flatMap((name) => [
			rule(`t3-code_${name}`, 'deny'),
			...(namespace === undefined ? [] : [rule(`${namespace}_${name}`, 'deny')]),
		]),
	]
}

function normalizeForRole(permissions: Permission.Ruleset, support: boolean): Permission.Ruleset {
	// T3 separates server and tool names with underscores, which are also legal
	// inside thread IDs. Its adjacent isolation/allow rules identify the boundary.
	const namespace = ownT3Namespace(permissions)
	let base = [...canonicalizeT3Permissions(permissions)]
	const previousPolicies = [managedRules(namespace, false), managedRules(namespace, true)]
	for (;;) {
		const previous = previousPolicies.find(
			(candidate) =>
				base.length >= candidate.length &&
				samePermissionRules(base.slice(-candidate.length), candidate),
		)
		if (previous === undefined) break
		base = base.slice(0, -previous.length)
	}
	return [
		// Native configuration already defines full access. A session-wide allow
		// would erase the restrictions of any native child that inherits it.
		...base.filter(
			(entry) => !(entry.action === '*' && entry.resource === '*' && entry.effect === 'allow'),
		),
		...managedRules(namespace, support),
	]
}

export function normalizeT3Permissions(
	permissions: Permission.Ruleset,
	agent: string | undefined,
): Permission.Ruleset {
	return normalizeForRole(permissions, isT3SupportAgent(agent))
}

/**
 * Recognize either repaired role: the agent may have changed since the plugin wrote these rules.
 */
export function isNormalizedT3Permissions(permissions: Permission.Ruleset): boolean {
	try {
		return [false, true].some((support) =>
			samePermissionRules(permissions, normalizeForRole(permissions, support)),
		)
	} catch (error) {
		// Malformed T3 anchors are reported when the rules are normalized.
		if (error instanceof T3PermissionError) return false
		throw error
	}
}
