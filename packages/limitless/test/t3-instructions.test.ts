import type { SessionRequest } from '@opencode/plugin/effect/session'
import { Effect } from 'effect'
import { expect, test } from 'vitest'
import { hasT3Context, injectT3Guidance, loadT3Guidance, T3_CONTEXT } from '../t3/instructions'

test('loads distinct T3-only Markdown templates', async () => {
	const guidance = await Effect.runPromise(loadT3Guidance())
	expect(guidance.primary).toContain('## T3 Code integration')
	expect(guidance.primary).toContain('t3_thread_launch')
	expect(guidance.primary).not.toContain('html_preview')
	expect(guidance.primary).not.toContain('html_render')
	expect(guidance.support).toContain('## T3 Code investigation tools')
	expect(guidance.support).not.toContain('t3_thread_launch')
})

test('replaces the marker in initial and chronological instructions without editing conversation content', () => {
	const request: Pick<SessionRequest, 'system' | 'messages'> = {
		system: [
			{ type: 'text', text: 'Unchanged agent instructions' },
			{ type: 'text', text: `<context key="t3-code">\n${T3_CONTEXT}\n</context>\nOther context` },
		],
		messages: [
			{ role: 'system', content: [{ type: 'text', text: `Updated context: ${T3_CONTEXT}` }] },
			{ role: 'user', content: [{ type: 'text', text: T3_CONTEXT }] },
			{ role: 'assistant', content: [{ type: 'text', text: T3_CONTEXT }] },
			{ role: 'tool', content: [{ type: 'text', text: T3_CONTEXT }] },
		],
	}
	expect(hasT3Context(request)).toBe(true)
	injectT3Guidance(request, 'Support-specific T3 guidance')
	expect(request.system[0]?.text).toBe('Unchanged agent instructions')
	expect(request.system[1]?.text).toBe(
		'<context key="t3-code">\nSupport-specific T3 guidance\n</context>\nOther context',
	)
	expect(request.messages[0]?.content).toEqual([
		{ type: 'text', text: 'Updated context: Support-specific T3 guidance' },
	])
	for (const message of request.messages.slice(1))
		expect(message.content).toEqual([{ type: 'text', text: T3_CONTEXT }])
	expect(hasT3Context(request)).toBe(false)
})

test('ordinary sessions have no T3 marker to expand', () => {
	expect(
		hasT3Context({ system: [{ type: 'text', text: 'Ordinary OpenCode guidance' }], messages: [] }),
	).toBe(false)
	expect(
		hasT3Context({
			system: [],
			messages: [{ role: 'user', content: [{ type: 'text', text: T3_CONTEXT }] }],
		}),
	).toBe(false)
})

test('a bound native child can receive its own section without inheriting a marker', () => {
	const request: Pick<SessionRequest, 'system' | 'messages'> = {
		system: [{ type: 'text', text: 'Original research instructions' }],
		messages: [],
	}
	injectT3Guidance(request, 'Support-specific T3 guidance', true)
	injectT3Guidance(request, 'Support-specific T3 guidance', true)
	expect(request.system).toEqual([
		{ type: 'text', text: 'Original research instructions' },
		{ type: 'text', text: 'Support-specific T3 guidance' },
	])
})
