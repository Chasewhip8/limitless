import type { Data } from '@opencode/plugin/tui/context'
import { describe, expect, test } from 'vitest'
import { cacheLifetimes, cacheStatus } from '../cache-status/status'

type Message = ReturnType<Data['session']['message']['list']>[number]
type Assistant = Extract<Message, { type: 'assistant' }>

const completed = 1_000_000

function assistant(
	providerID: string,
	time: Assistant['time'] = { created: 1, completed },
): Message {
	return {
		id: 'msg_answer',
		type: 'assistant',
		agent: 'limitless',
		model: { providerID, id: 'test' },
		content: [],
		time,
	}
}

function user(): Message {
	return {
		id: 'msg_user',
		type: 'user',
		text: 'Next question',
		time: { created: completed + 1 },
	}
}

function statusAt(now: number, messages: readonly Message[], running = false) {
	return cacheStatus({ messages, running, now })
}

describe('cacheStatus', () => {
	test('has no status before the first model reply', () => {
		expect(statusAt(completed, [user()])).toBeUndefined()
	})

	test('stays warm until the provider lifetime after the latest reply elapses', () => {
		const messages = [assistant('anthropic')]
		const expiresAt = completed + (cacheLifetimes.anthropic ?? 0)

		expect(statusAt(expiresAt - 1, messages)).toEqual({ state: 'warm', expiresAt })
		expect(statusAt(expiresAt, messages)).toEqual({ state: 'cold' })
	})

	test('uses the 30-minute OpenAI lifetime', () => {
		const messages = [assistant('openai')]

		expect(statusAt(completed + 29 * 60_000, messages)?.state).toBe('warm')
		expect(statusAt(completed + 30 * 60_000, messages)?.state).toBe('cold')
	})

	test('measures from the latest assistant reply, ignoring later user input', () => {
		const messages = [assistant('anthropic'), user()]

		expect(statusAt(completed + 6 * 60_000, messages)?.state).toBe('cold')
	})

	test('is warm while a request is in flight, even after the previous lifetime elapsed', () => {
		expect(statusAt(completed + 60 * 60_000, [assistant('anthropic')], true)).toEqual({
			state: 'warm',
		})
	})

	test('measures an unfinished reply from its creation time', () => {
		const messages = [assistant('anthropic', { created: completed })]

		expect(statusAt(completed + 4 * 60_000, messages)?.state).toBe('warm')
		expect(statusAt(completed + 5 * 60_000, messages)?.state).toBe('cold')
	})

	test('is unknown for providers without a configured lifetime', () => {
		expect(statusAt(completed, [assistant('google')])).toEqual({ state: 'unknown' })
		expect(statusAt(completed, [assistant('google')], true)).toEqual({ state: 'unknown' })
	})
})
