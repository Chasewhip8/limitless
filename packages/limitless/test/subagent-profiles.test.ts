import { readFile } from 'node:fs/promises'
import type { SessionContext } from '@opencode/plugin/effect/session'
import { Agent } from '@opencode/schema/agent'
import { Model } from '@opencode/schema/model'
import { Session } from '@opencode/schema/session'
import { Effect, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { resolvePluginConfigs } from '../index'
import {
	DEFAULT_FAST_SUBAGENTS,
	makeSubagentProfileHook,
	normalizeSubagentProfileConfig,
	SubagentProfileConfig,
	SubagentProfileConfigError,
	SubagentProfileError,
	type SubagentProfileSessionLookup,
} from '../plugin/subagent-profiles'

const rootID = Session.ID.make('ses_root')
const childID = Session.ID.make('ses_child')
const nestedID = Session.ID.make('ses_nested')

function request(
	sessionID = childID,
	agent = 'research',
	model = 'gpt-6-astra',
	providerID = 'openai',
): SessionContext {
	return {
		sessionID,
		agent: Agent.ID.make(agent),
		model: Schema.decodeUnknownSync(Model.Ref)({ providerID, id: model, variant: 'medium' }),
		system: [],
		messages: [],
		tools: {},
		generation: { maxTokens: 4096 },
		providerOptions: { reasoningEffort: 'medium' },
	}
}

function sessionTree(
	rootAgent = 'limitless',
	fastSubagents: readonly string[] = DEFAULT_FAST_SUBAGENTS,
) {
	const root = { agent: Agent.ID.make(rootAgent) }
	const sessions = new Map<Session.ID, Pick<Session.Info, 'parentID' | 'agent'>>([
		[rootID, root],
		[childID, { parentID: rootID, agent: Agent.ID.make('research') }],
		[nestedID, { parentID: childID, agent: Agent.ID.make('research') }],
	])
	const lookups: Session.ID[] = []
	const lookupSession: SubagentProfileSessionLookup = (id) =>
		Effect.suspend(() => {
			lookups.push(id)
			const session = sessions.get(id)
			return session === undefined
				? Effect.fail(new SubagentProfileError({ message: `Missing session ${id}` }))
				: Effect.succeed(session)
		})
	return {
		root,
		sessions,
		lookups,
		apply: makeSubagentProfileHook(SubagentProfileConfig.make({ fastSubagents }), lookupSession),
	}
}

describe('subagent profile configuration', () => {
	test('enables profiles for the bundled OpenAI specialists by default', async () => {
		const config = await Effect.runPromise(normalizeSubagentProfileConfig({}))
		expect(config.fastSubagents).toEqual(DEFAULT_FAST_SUBAGENTS)
	})

	test.each([
		{ agent: 'oracle-solve', variant: 'max' },
		{ agent: 'research', variant: 'medium' },
		{ agent: 'review', variant: 'max' },
		{ agent: 'worker', variant: 'medium' },
	])('bundles $agent with standard Astra and $variant reasoning', async ({ agent, variant }) => {
		const content = await readFile(
			new URL(`../../../opencode/agents/${agent}.md`, import.meta.url),
			'utf8',
		)
		expect(DEFAULT_FAST_SUBAGENTS).toContain(agent)
		expect(content).toContain('\nmode: subagent\n')
		expect(content).toContain(`\nmodel: openai/gpt-6-astra#${variant}\n`)
	})

	test('passes an explicit agent list through plugin configuration and deduplicates it', async () => {
		const configs = await Effect.runPromise(
			resolvePluginConfigs({
				lsp: {},
				agents: { fastSubagents: [' worker ', 'custom-agent', 'worker'] },
			}),
		)
		expect(configs.subagentProfiles.fastSubagents).toEqual(['worker', 'custom-agent'])
	})

	test('supports an empty list', async () => {
		const config = await Effect.runPromise(
			normalizeSubagentProfileConfig({ agents: { fastSubagents: [] } }),
		)
		expect(config.fastSubagents).toEqual([])
	})

	test.each([null, 'research', [''], ['  '], [1]])('rejects malformed lists: %j', async (value) => {
		const error = await Effect.runPromise(
			normalizeSubagentProfileConfig({ agents: { fastSubagents: value } }).pipe(Effect.flip),
		)
		expect(error).toBeInstanceOf(SubagentProfileConfigError)
	})
})

describe('subagent speed profiles', () => {
	test.each([
		['limitless', 'default'],
		['limitless-fast', 'priority'],
	])('%s sets the processing tier to %s', async (agent, tier) => {
		const tree = sessionTree(agent)
		const event = request()
		const original = structuredClone(event)

		await Effect.runPromise(tree.apply(event))

		expect(event).toEqual({
			...original,
			providerOptions: { ...original.providerOptions, serviceTier: tier },
		})
		expect(tree.lookups).toEqual([childID, rootID])
	})

	test.each(DEFAULT_FAST_SUBAGENTS)('controls the default eligible agent %s', async (agent) => {
		const tree = sessionTree()
		const event = request(childID, agent)
		await Effect.runPromise(tree.apply(event))
		expect(event.providerOptions.serviceTier).toBe('default')
	})

	test.each([
		'limitless',
		'limitless-fast',
	])('preserves %s main model and request settings', async (agent) => {
		const tree = sessionTree(agent, [agent])
		const event = request(rootID, agent, 'gpt-6-astra-fast')
		event.providerOptions.serviceTier = 'priority'
		const original = structuredClone(event)

		await Effect.runPromise(tree.apply(event))

		expect(event).toEqual(original)
		expect(tree.lookups).toEqual([rootID])
	})

	test('resolves research nested beneath an Anthropic Oracle', async () => {
		const tree = sessionTree()
		tree.sessions.set(childID, { parentID: rootID, agent: Agent.ID.make('oracle-design') })
		const event = request(nestedID)
		await Effect.runPromise(tree.apply(event))
		expect(event.providerOptions.serviceTier).toBe('default')
		expect(tree.lookups).toEqual([nestedID, childID, rootID])
	})

	test('uses the current profile for subsequent requests in an existing child', async () => {
		const tree = sessionTree()
		const first = request(nestedID)
		await Effect.runPromise(tree.apply(first))
		tree.root.agent = Agent.ID.make('limitless-fast')
		const second = request(nestedID)
		await Effect.runPromise(tree.apply(second))
		tree.root.agent = Agent.ID.make('limitless')
		const third = request(nestedID)
		await Effect.runPromise(tree.apply(third))

		expect(first.providerOptions.serviceTier).toBe('default')
		expect(second.providerOptions.serviceTier).toBe('priority')
		expect(third.providerOptions.serviceTier).toBe('default')
	})

	test('keeps concurrent root profiles independent', async () => {
		const tree = sessionTree()
		const fastRootID = Session.ID.make('ses_fast_root')
		const fastChildID = Session.ID.make('ses_fast_child')
		tree.sessions.set(fastRootID, { agent: Agent.ID.make('limitless-fast') })
		tree.sessions.set(fastChildID, { parentID: fastRootID, agent: Agent.ID.make('research') })
		const standard = request()
		const fast = request(fastChildID)
		await Effect.runPromise(
			Effect.all([tree.apply(standard), tree.apply(fast)], { concurrency: 'unbounded' }),
		)
		expect(standard.providerOptions.serviceTier).toBe('default')
		expect(fast.providerOptions.serviceTier).toBe('priority')
	})

	test.each([
		'anthropic',
		'google-vertex-anthropic',
		'custom-provider',
	])('preserves requests to %s even when the agent is explicitly listed', async (providerID) => {
		const tree = sessionTree('limitless-fast', ['oracle-design'])
		const event = request(childID, 'oracle-design', 'claude-fable-5-1', providerID)
		const original = structuredClone(event)
		await Effect.runPromise(tree.apply(event))
		expect(event).toEqual(original)
		expect(tree.lookups).toEqual([])
	})

	test.each([
		{ fastSubagents: [] },
		{ fastSubagents: ['worker'] },
	])('preserves excluded agents with allowlist $fastSubagents', async ({ fastSubagents }) => {
		const tree = sessionTree('limitless-fast', fastSubagents)
		const event = request()
		const original = structuredClone(event)
		await Effect.runPromise(tree.apply(event))
		expect(event).toEqual(original)
		expect(tree.lookups).toEqual([])
	})

	test('applies the tier to a custom listed OpenAI agent without changing its model', async () => {
		const tree = sessionTree('limitless-fast', ['custom-agent'])
		const event = request(childID, 'custom-agent', 'gpt-6-astra')
		await Effect.runPromise(tree.apply(event))
		expect(event.providerOptions.serviceTier).toBe('priority')
		expect(event.model.id).toBe('gpt-6-astra')
	})

	test.each([
		'gary',
		'custom-primary',
	])('preserves child settings under unrelated root %s', async (agent) => {
		const tree = sessionTree(agent)
		const event = request()
		const original = structuredClone(event)
		await Effect.runPromise(tree.apply(event))
		expect(event).toEqual(original)
	})

	test('overrides Fast model settings in existing child sessions under the Standard profile', async () => {
		const tree = sessionTree()
		const event = request(childID, 'research', 'gpt-6-astra-fast')
		event.providerOptions.serviceTier = 'priority'
		await Effect.runPromise(tree.apply(event))
		expect(event.providerOptions.serviceTier).toBe('default')
	})

	test('fails on an unavailable ancestor without applying a partial override', async () => {
		const tree = sessionTree()
		tree.sessions.delete(rootID)
		const event = request()
		const error = await Effect.runPromise(tree.apply(event).pipe(Effect.flip))
		expect(error).toBeInstanceOf(SubagentProfileError)
		expect(error.message).toContain(rootID)
		expect(event.providerOptions.serviceTier).toBeUndefined()
	})

	test('fails on cyclic ancestry', async () => {
		const tree = sessionTree()
		tree.sessions.set(rootID, { parentID: childID, agent: Agent.ID.make('limitless') })
		const event = request()
		const error = await Effect.runPromise(tree.apply(event).pipe(Effect.flip))
		expect(error).toBeInstanceOf(SubagentProfileError)
		expect(error.message).toContain('cycle in ancestry')
		expect(event.providerOptions.serviceTier).toBeUndefined()
	})
})
