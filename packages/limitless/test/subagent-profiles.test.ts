import { readFile } from 'node:fs/promises'
import type { SessionContext, SessionDomain } from '@opencode/plugin/effect/session'
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
	registerSubagentProfileHooks,
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
		options: {},
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
		expect(config.fastSubagents).toEqual(['oracle-solve', 'research', 'worker'])
	})

	test.each([
		{ agent: 'oracle-solve', model: 'gpt-6-astra', variant: 'xhigh' },
		{ agent: 'research', model: 'gpt-5.6-sol', variant: 'medium' },
		{ agent: 'worker', model: 'gpt-5.6-sol', variant: 'medium' },
	])('bundles $agent with $model and $variant reasoning', async ({ agent, model, variant }) => {
		const content = await readFile(
			new URL(`../../../opencode/agents/${agent}.md`, import.meta.url),
			'utf8',
		)
		expect(DEFAULT_FAST_SUBAGENTS).toContain(agent)
		expect(content).toContain('\nmode: subagent\n')
		expect(content).toContain(`\nmodel: openai/${model}#${variant}\n`)
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
	test('registers OpenAI hooks for agent, compaction, and transient requests', async () => {
		const tree = sessionTree()
		const names: string[] = []
		const hook: SessionDomain['hook'] = (name, _callback, options) =>
			Effect.sync(() => {
				names.push(name)
				expect(options).toEqual({ providerID: 'openai' })
				return { dispose: Effect.void }
			})
		await Effect.runPromise(registerSubagentProfileHooks({ hook }, tree.apply).pipe(Effect.scoped))
		expect(names).toEqual(['context', 'compaction', 'generate'])
	})

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
			options: { ...original.options, serviceTier: tier },
		})
		expect(tree.lookups).toEqual([childID, rootID])
	})

	test('preserves generation and provider overrides from earlier hooks', async () => {
		const tree = sessionTree('limitless-fast')
		const event = request()
		event.options = { maxTokens: 4096, reasoningEffort: 'medium', serviceTier: 'default' }
		await Effect.runPromise(tree.apply(event))
		expect(event.options).toEqual({
			maxTokens: 4096,
			reasoningEffort: 'medium',
			serviceTier: 'priority',
		})
	})

	test.each(DEFAULT_FAST_SUBAGENTS)('controls the default eligible agent %s', async (agent) => {
		const tree = sessionTree()
		const event = request(childID, agent)
		await Effect.runPromise(tree.apply(event))
		expect(event.options.serviceTier).toBe('default')
	})

	test.each([
		'limitless',
		'limitless-fast',
	])('preserves %s main model and request settings', async (agent) => {
		const tree = sessionTree(agent, [agent])
		const event = request(rootID, agent, 'gpt-6-astra-fast')
		event.options.serviceTier = 'priority'
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
		expect(event.options.serviceTier).toBe('default')
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

		expect(first.options.serviceTier).toBe('default')
		expect(second.options.serviceTier).toBe('priority')
		expect(third.options.serviceTier).toBe('default')
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
		expect(standard.options.serviceTier).toBe('default')
		expect(fast.options.serviceTier).toBe('priority')
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
		expect(event.options.serviceTier).toBe('priority')
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
		event.options.serviceTier = 'priority'
		await Effect.runPromise(tree.apply(event))
		expect(event.options.serviceTier).toBe('default')
	})

	test('fails on an unavailable ancestor without applying a partial override', async () => {
		const tree = sessionTree()
		tree.sessions.delete(rootID)
		const event = request()
		const error = await Effect.runPromise(tree.apply(event).pipe(Effect.flip))
		expect(error).toBeInstanceOf(SubagentProfileError)
		expect(error.message).toContain(rootID)
		expect(event.options.serviceTier).toBeUndefined()
	})

	test('fails on cyclic ancestry', async () => {
		const tree = sessionTree()
		tree.sessions.set(rootID, { parentID: childID, agent: Agent.ID.make('limitless') })
		const event = request()
		const error = await Effect.runPromise(tree.apply(event).pipe(Effect.flip))
		expect(error).toBeInstanceOf(SubagentProfileError)
		expect(error.message).toContain('cycle in ancestry')
		expect(event.options.serviceTier).toBeUndefined()
	})
})
