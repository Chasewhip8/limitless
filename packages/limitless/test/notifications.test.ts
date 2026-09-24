import type { AttentionNotifyOptions, Data, ToastOptions } from '@opencode/plugin/tui/context'
import { describe, expect, test, vi } from 'vitest'
import { type NotificationContext, registerNotifications } from '../plugin/notifications'
import notificationsPlugin from '../tui'

type Event = Parameters<Parameters<Data['listen']>[0]>[0]['details']
type EventMap = { [Type in Event['type']]: Extract<Event, { type: Type }> }
type Message = ReturnType<Data['session']['message']['list']>[number]
type Assistant = Extract<Message, { type: 'assistant' }>

function matchesEvent<Type extends Event['type']>(
	event: Event,
	type: Type,
): event is EventMap[Type] {
	return event.type === type
}

function assistant(overrides: Partial<Assistant> = {}): Assistant {
	return {
		id: 'msg_answer',
		type: 'assistant',
		agent: 'limitless',
		model: { providerID: 'openai', id: 'test' },
		content: [{ type: 'text', text: 'Finished the requested work.' }],
		finish: 'stop',
		time: { created: 1, completed: 2 },
		...overrides,
	}
}

function idle(eventID = 'evt_done'): Message {
	return {
		id: eventID.replace(/^evt_/, 'msg_'),
		type: 'idle',
		outcome: 'succeeded',
		time: { created: 3 },
	}
}

function succeeded(id = 'evt_done', sessionID = 'root'): Event {
	return {
		id,
		created: 3,
		type: 'session.execution.succeeded',
		durable: { aggregateID: sessionID, seq: 1, version: 1 },
		data: { sessionID },
	}
}

function started(sessionID = 'root'): Event {
	return {
		id: 'evt_started',
		created: 0,
		type: 'session.execution.started',
		durable: { aggregateID: sessionID, seq: 0, version: 1 },
		data: { sessionID },
	}
}

function question(sessionID = 'root'): Event {
	return {
		id: 'evt_question',
		created: 1,
		type: 'form.created',
		data: {
			form: {
				id: 'form_question',
				sessionID,
				title: 'Choose an approach',
				fields: [{ key: 'answer', type: 'string' }],
			},
		},
	}
}

function permission(sessionID = 'root'): Event {
	return {
		id: 'evt_permission',
		created: 1,
		type: 'permission.asked',
		data: { id: 'per_request', sessionID, action: 'edit', resources: ['file.ts'] },
	}
}

function harness() {
	const notifications: AttentionNotifyOptions[] = []
	const toasts: ToastOptions[] = []
	const listeners = new Set<(event: Event) => void>()
	const sessions = new Map<string, { title: string; parentID?: string }>([
		['root', { title: 'Main session' }],
		['child', { title: 'Oracle', parentID: 'root' }],
	])
	const messages = new Map<string, Message[]>([['root', [assistant(), idle()]]])
	const pending = new Map<string, unknown[]>()
	const statuses = new Map<string, 'idle' | 'running'>()
	const sync = {
		session: vi.fn(async (_sessionID: string) => {}),
		messages: vi.fn(async (_sessionID: string) => {}),
		pending: vi.fn(async (_sessionID: string) => {}),
	}
	const context: NotificationContext = {
		attention: {
			async notify(input) {
				notifications.push(input)
				return {
					ok: true,
					notification: input.notification !== false,
					sound: input.sound !== false,
				}
			},
		},
		ui: { toast: { show: (input) => toasts.push(input) } },
		data: {
			on(type, handler) {
				const listener = (event: Event) => {
					if (matchesEvent(event, type)) return handler(event)
				}
				listeners.add(listener)
				return () => {
					listeners.delete(listener)
				}
			},
			session: {
				get: (id) => sessions.get(id),
				sync: sync.session,
				status: (id) => statuses.get(id) ?? 'idle',
				message: { list: (id) => messages.get(id) ?? [], sync: sync.messages },
				pending: { list: (id) => pending.get(id) ?? [], sync: sync.pending },
			},
		},
	}
	const cleanup = registerNotifications(context)
	return {
		sessions,
		messages,
		pending,
		statuses,
		notifications,
		toasts,
		sync,
		cleanup,
		listeners,
		sounds: () => notifications.filter((input) => input.sound !== false),
		async emit(event: Event) {
			await Promise.all([...listeners].map((listener) => listener(event)))
		},
	}
}

describe('notification sounds', () => {
	test('replaces the pinned built-in notification handler', () => {
		expect(notificationsPlugin.id).toBe('opencode.notifications')
		expect(notificationsPlugin.setup).toBe(registerNotifications)
	})

	test('sounds once for a final main-session answer and preserves its visual notification', async () => {
		const state = harness()
		await state.emit(succeeded())
		await state.emit(succeeded())
		expect(state.notifications).toEqual([
			{
				title: 'Main session',
				message: 'Session done',
				notification: { when: 'blurred' },
				sound: false,
			},
			{
				title: 'Main session',
				message: 'Session done',
				notification: false,
				sound: { name: 'done', when: 'always' },
			},
		])
	})

	test('sounds for a later main answer even if its start event was missed', async () => {
		const state = harness()
		await state.emit(succeeded())
		state.messages.set('root', [
			assistant(),
			idle(),
			assistant({ id: 'msg_next' }),
			idle('evt_next'),
		])
		await state.emit(succeeded('evt_next'))
		expect(state.sounds()).toHaveLength(2)
	})

	test('does not sound for child completion', async () => {
		const state = harness()
		state.messages.set('child', [assistant(), idle()])
		await state.emit(succeeded('evt_done', 'child'))
		expect(state.notifications).toEqual([])
		expect(state.sync.messages).not.toHaveBeenCalled()
	})

	test('does not sound just because an assistant message has completed', async () => {
		const state = harness()
		state.messages.set('root', [assistant()])
		await state.emit(started())
		await state.emit({
			id: 'evt_step',
			created: 2,
			type: 'session.step.ended',
			durable: { aggregateID: 'root', seq: 1, version: 1 },
			data: {
				sessionID: 'root',
				assistantMessageID: 'msg_answer',
				finish: 'stop',
				cost: 0,
				tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
			},
		})
		expect(state.sounds()).toEqual([])
	})

	test('deduplicates concurrent completion callbacks after hydration', async () => {
		const state = harness()
		await Promise.all([state.emit(succeeded()), state.emit(succeeded())])
		expect(state.sounds()).toHaveLength(1)
	})

	test.each<[string, Assistant]>([
		['incomplete', assistant({ time: { created: 1 } })],
		['tool continuation', assistant({ finish: 'tool-calls' })],
		['truncated', assistant({ finish: 'length' })],
		['errored', assistant({ error: { type: 'unknown', message: 'Failure' } })],
		['empty', assistant({ content: [] })],
		['whitespace', assistant({ content: [{ type: 'text', text: '  ' }] })],
		['reasoning only', assistant({ content: [{ type: 'reasoning', text: 'Thinking' }] })],
	])('does not sound for an %s last assistant or fall back to an earlier answer', async (_name, message) => {
		const state = harness()
		state.messages.set('root', [assistant({ id: 'msg_earlier' }), message, idle()])
		await state.emit(succeeded())
		expect(state.sounds()).toEqual([])
	})

	test.each<[string, Message[]]>([
		['empty run', [idle()]],
		['no matching boundary', [assistant(), idle('evt_other')]],
		['old answer', [assistant(), idle('evt_previous'), idle()]],
		[
			'unanswered input',
			[
				assistant(),
				{ id: 'msg_user', type: 'user', text: 'More work', time: { created: 2 } },
				idle(),
			],
		],
		[
			'synthetic continuation',
			[
				assistant(),
				{ id: 'msg_synthetic', type: 'synthetic', text: 'Child result', time: { created: 2 } },
				idle(),
			],
		],
		[
			'compaction only',
			[
				{
					id: 'msg_compact',
					type: 'compaction',
					status: 'completed',
					reason: 'manual',
					summary: 'Summary',
					recent: '',
					time: { created: 2 },
				},
				idle(),
			],
		],
		[
			'failed compaction',
			[
				assistant(),
				{
					id: 'msg_compact',
					type: 'compaction',
					status: 'failed',
					reason: 'manual',
					error: { type: 'unknown', message: 'Failed' },
					time: { created: 2 },
				},
				idle(),
			],
		],
	])('does not sound for %s', async (_name, messages) => {
		const state = harness()
		state.messages.set('root', messages)
		await state.emit(succeeded())
		expect(state.sounds()).toEqual([])
	})

	test('permits successful compaction after a new final answer', async () => {
		const state = harness()
		state.messages.set('root', [
			assistant(),
			{
				id: 'msg_compact',
				type: 'compaction',
				status: 'completed',
				reason: 'auto',
				summary: 'Summary',
				recent: '',
				time: { created: 2 },
			},
			idle(),
		])
		await state.emit(succeeded())
		expect(state.sounds()).toHaveLength(1)
	})

	test('hydrates missing ownership before treating a session as top-level', async () => {
		const state = harness()
		state.sessions.delete('root')
		state.sync.session.mockImplementationOnce(async () => {
			state.sessions.set('root', { title: 'Loaded session' })
		})
		await state.emit(succeeded())
		expect(state.sync.session).toHaveBeenCalledWith('root')
		expect(state.sounds()).toHaveLength(1)
	})

	test.each([
		'missing',
		'child',
	])('does not infer root ownership from %s session data', async (kind) => {
		const state = harness()
		state.sessions.delete('root')
		state.sync.session.mockImplementationOnce(async () => {
			if (kind === 'child')
				state.sessions.set('root', { title: 'Loaded child', parentID: 'parent' })
		})
		await state.emit(succeeded())
		expect(state.sounds()).toEqual([])
	})

	test.each([
		'running',
		'pending',
		'new terminal',
		'disposed',
	])('rechecks %s state after hydration', async (kind) => {
		const state = harness()
		state.sync.messages.mockImplementationOnce(async () => {
			if (kind === 'running') state.statuses.set('root', 'running')
			if (kind === 'pending') state.pending.set('root', ['queued input'])
			if (kind === 'new terminal') state.messages.set('root', [assistant(), idle('evt_newer')])
			if (kind === 'disposed') state.cleanup()
		})
		await state.emit(succeeded())
		expect(state.sounds()).toEqual([])
	})

	test('reports hydration failures without announcing completion', async () => {
		const state = harness()
		const error = new Error('Cannot load messages')
		const log = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			state.sync.messages.mockRejectedValueOnce(error)
			await state.emit(succeeded())
			expect(state.sounds()).toEqual([])
			expect(log).toHaveBeenCalledWith('[limitless] Notification failed', error)
		} finally {
			log.mockRestore()
		}
	})

	test('keeps errors and interruptions silent while retaining visual feedback', async () => {
		const state = harness()
		await state.emit({
			id: 'evt_failed',
			created: 3,
			type: 'session.execution.failed',
			durable: { aggregateID: 'root', seq: 1, version: 1 },
			data: { sessionID: 'root', error: { type: 'unknown', message: 'Failure' } },
		})
		await state.emit(started())
		await state.emit({
			id: 'evt_interrupted',
			created: 4,
			type: 'session.execution.interrupted',
			durable: { aggregateID: 'root', seq: 3, version: 1 },
			data: { sessionID: 'root', reason: 'user' },
		})
		expect(state.sounds()).toEqual([])
		expect(state.toasts).toEqual([
			{ sessionID: 'root', title: 'Session failed', message: 'Failure', variant: 'error' },
		])
		expect(state.notifications).toHaveLength(2)
	})

	test.each([
		'root',
		'child',
		'global',
	])('sounds for questions and permissions from %s', async (sessionID) => {
		const state = harness()
		await state.emit(question(sessionID))
		await state.emit(permission(sessionID))
		expect(state.sounds().map((input) => input.sound)).toEqual([
			{ name: 'question', when: 'always' },
			{ name: 'permission', when: 'always' },
		])
		if (sessionID === 'child')
			expect(state.notifications.every((input) => input.notification === false)).toBe(true)
	})

	test('deduplicates pending prompts and releases their IDs on resolution', async () => {
		const state = harness()
		await state.emit(question())
		await state.emit(question())
		await state.emit(permission())
		await state.emit(permission())
		expect(state.sounds()).toHaveLength(2)
		await state.emit({
			id: 'evt_cancel',
			created: 2,
			type: 'form.cancelled',
			data: { sessionID: 'root', id: 'form_question' },
		})
		await state.emit({
			id: 'evt_reply',
			created: 2,
			type: 'permission.replied',
			data: { sessionID: 'root', requestID: 'per_request', reply: 'once' },
		})
		await state.emit(question())
		await state.emit(permission())
		expect(state.sounds()).toHaveLength(4)
	})

	test('unsubscribes every handler on cleanup', async () => {
		const state = harness()
		state.cleanup()
		expect(state.listeners.size).toBe(0)
		await state.emit(question())
		await state.emit(permission())
		await state.emit(succeeded())
		expect(state.notifications).toEqual([])
	})
})
