import { Effect } from 'effect'
import { describe, expect, test, vi } from 'vitest'
import {
	chunkSlackMarkdown,
	createSlackRunner,
	isSlackCancelCommand,
	MAX_SLACK_IMAGE_BYTES,
	MAX_SLACK_MARKDOWN_CHARS,
	normalizeSlackConfig,
	selectSlackImageIDs,
	slackThreadKey,
	stripSlackBotMention,
} from '../integrations/slack/index'
import type { SlackAppFactory, SlackAppHandle } from '../integrations/slack/runtime'
import type { SlackMessage } from '../integrations/slack/schema'

const runEffect = Effect.runPromise

function mention(eventID: string, ts: string, text: string, channel = 'C1', threadTs = '1.000001') {
	return {
		body: { team_id: 'T1', event_id: eventID },
		event: {
			type: 'app_mention',
			user: 'U1',
			text,
			channel,
			ts,
			thread_ts: threadTs,
		},
	}
}

async function makeHarness(
	histories: Map<string, Array<SlackMessage>>,
	behavior: {
		assistantError?: string
		assistantParentID?:
			| string
			| ((input: { call: number; latestPromptID: string | undefined; sessionID: string }) => string)
		assistantText?: string
		fetch?: typeof globalThis.fetch
		create?: (args: { signal?: AbortSignal }) => Promise<{ data: { id: string } }>
		promptAsync?: (args: {
			path: { id: string }
			body: {
				agent: string
				messageID: string
				tools: Record<string, boolean>
				parts: Array<{ type: string; text?: string }>
			}
		}) => Promise<{ data: undefined }>
		update?: (args: Record<string, unknown>) => Promise<{ ok: boolean }>
	} = {},
) {
	let sessionCounter = 0
	let slackMessageCounter = 0
	const latestPromptBySession = new Map<string, string>()
	const create = vi.fn(
		(args: { signal?: AbortSignal }) =>
			behavior.create?.(args).then((response) => {
				sessionCounter += 1
				return response
			}) ?? Promise.resolve({ data: { id: `session-${++sessionCounter}` } }),
	)
	const prompt = vi.fn(() => Promise.resolve({ data: {} }))
	const promptAsync = vi.fn(
		(_args: {
			path: { id: string }
			body: {
				agent: string
				messageID: string
				tools: Record<string, boolean>
				parts: Array<{ type: string; text?: string }>
			}
		}) => {
			latestPromptBySession.set(_args.path.id, _args.body.messageID)
			return behavior.promptAsync?.(_args) ?? Promise.resolve({ data: undefined })
		},
	)
	const abort = vi.fn(() => Promise.resolve({ data: true }))
	const rejectPermission = vi.fn(() => Promise.resolve({ data: true }))
	const messages = vi.fn((args: { path: { id: string } }) => {
		const parentID = latestPromptBySession.get(args.path.id)
		const configuredParent =
			typeof behavior.assistantParentID === 'function'
				? behavior.assistantParentID({
						call: messages.mock.calls.length,
						latestPromptID: parentID,
						sessionID: args.path.id,
					})
				: behavior.assistantParentID
		return Promise.resolve({
			data: [
				{
					info: {
						id: 'msg_ffffffffffffffffffffffffff',
						role: 'assistant',
						parentID: configuredParent ?? parentID,
						time: { created: Date.now() + 1_000 },
						...(behavior.assistantError === undefined
							? {}
							: { error: { name: behavior.assistantError, data: {} } }),
					},
					parts: [
						{ type: 'text', text: behavior.assistantText ?? '**Final answer**', ignored: false },
					],
				},
			],
		})
	})
	const postMessage = vi.fn(() =>
		Promise.resolve({ ok: true, ts: `status-${++slackMessageCounter}` }),
	)
	const update = vi.fn(behavior.update ?? (() => Promise.resolve({ ok: true })))
	const replies = vi.fn((args: { channel: string }) =>
		Promise.resolve({
			ok: true,
			messages: histories.get(args.channel) ?? [],
			response_metadata: { next_cursor: '' },
		}),
	)
	const slackClient = {
		auth: { test: () => Promise.resolve({ ok: true, user_id: 'UBOT', team_id: 'T1' }) },
		chat: { postMessage, update },
		conversations: { replies },
	}
	const handle: SlackAppHandle = {
		client: slackClient as unknown as SlackAppHandle['client'],
		start: () => Promise.resolve(),
		stop: () => Promise.resolve(),
	}
	const makeApp = vi.fn(() => handle) as SlackAppFactory
	const markReady = vi.fn(() => Promise.resolve())
	const clearReady = vi.fn(() => Promise.resolve())
	const fetch = vi.fn(
		behavior.fetch ??
			(() =>
				Promise.resolve(
					new Response(new Uint8Array([1, 2, 3]), {
						status: 200,
						headers: { 'content-length': '3' },
					}),
				)),
	) as unknown as typeof globalThis.fetch
	const config = await runEffect(
		normalizeSlackConfig({
			slack: { enable: true, repository: '/repo', agent: 'slack-agent' },
		}),
	)
	const runner = await runEffect(
		createSlackRunner(
			config,
			{
				directory: '/repo',
				client: {
					postSessionIdPermissionsPermissionId: rejectPermission,
					session: { create, prompt, promptAsync, abort, messages },
				} as never,
			},
			{
				env: {
					LIMITLESS_SLACK_SERVICE: '1',
					SLACK_BOT_TOKEN: 'xoxb-test',
					SLACK_APP_TOKEN: 'xapp-test',
				},
				resolveDirectory: (directory) => Promise.resolve(directory),
				makeApp,
				fetch,
				readyFile: '/tmp/limitless-slack-test-ready',
				markReady,
				clearReady,
			},
		),
	)
	await runEffect(runner.start(() => Promise.resolve()))
	return {
		runner,
		mocks: {
			abort,
			clearReady,
			create,
			fetch,
			messages,
			markReady,
			postMessage,
			prompt,
			promptAsync,
			rejectPermission,
			replies,
			update,
		},
	}
}

describe('Slack configuration', () => {
	test('is disabled by default and validates enabled repositories', async () => {
		const disabled = await runEffect(normalizeSlackConfig(undefined))
		expect(disabled.enabled).toBe(false)
		expect(disabled.agent).toBe('gary')

		const error = await runEffect(
			normalizeSlackConfig({ slack: { enable: true, repository: 'relative' } }).pipe(Effect.flip),
		)
		expect(error._tag).toBe('SlackConfigError')
		expect(error.message).toContain('absolute path')
	})
})

describe('Slack message helpers', () => {
	test('normalizes thread keys, mentions, cancellation, and long Markdown', () => {
		expect(slackThreadKey('T1', 'C1', '1.2')).toBe('T1:C1:1.2')
		expect(stripSlackBotMention('  <@UBOT>   fix it ', 'UBOT')).toBe('fix it')
		expect(isSlackCancelCommand('<@UBOT> cancel', 'UBOT')).toBe(true)
		expect(isSlackCancelCommand('<@UBOT> cancel the build', 'UBOT')).toBe(false)

		const chunks = chunkSlackMarkdown(`a\n${'b'.repeat(MAX_SLACK_MARKDOWN_CHARS + 20)}`)
		expect(chunks.length).toBe(2)
		expect(chunks.every((chunk) => chunk.length <= MAX_SLACK_MARKDOWN_CHARS)).toBe(true)
	})

	test('prioritizes triggering images and enforces count and metadata size limits', () => {
		const messages: Array<SlackMessage> = [
			{
				ts: '1.0',
				files: [
					{
						id: 'old',
						mimetype: 'image/png',
						size: 10,
						url_private: 'https://files.slack.com/old',
					},
				],
			},
			{
				ts: '2.0',
				files: [
					...['a', 'b', 'c', 'd'].map((id) => ({
						id,
						mimetype: 'image/png',
						size: 10,
						url_private: `https://files.slack.com/${id}`,
					})),
					{
						id: 'large',
						mimetype: 'image/png',
						size: MAX_SLACK_IMAGE_BYTES + 1,
						url_private: 'https://files.slack.com/large',
					},
				],
			},
		]

		expect([...selectSlackImageIDs(messages, '2.0')]).toEqual(['a', 'b', 'c', 'd'])
	})
})

describe('Slack bridge runner', () => {
	test('starts only in the activated service and configured repository instance', async () => {
		const config = await runEffect(
			normalizeSlackConfig({ slack: { enable: true, repository: '/repo' } }),
		)
		const makeApp = vi.fn() as SlackAppFactory
		const inactive = await runEffect(
			createSlackRunner(
				config,
				{ directory: '/repo', client: {} as never },
				{
					env: {},
					resolveDirectory: (directory) => Promise.resolve(directory),
					makeApp,
				},
			),
		)
		await runEffect(inactive.start(() => Promise.resolve()))

		const wrongRepository = await runEffect(
			createSlackRunner(
				config,
				{ directory: '/other', client: {} as never },
				{
					env: {
						LIMITLESS_SLACK_SERVICE: '1',
						SLACK_BOT_TOKEN: 'xoxb-test',
						SLACK_APP_TOKEN: 'xapp-test',
					},
					resolveDirectory: (directory) => Promise.resolve(directory),
					makeApp,
				},
			),
		)
		await runEffect(wrongRepository.start(() => Promise.resolve()))
		expect(makeApp).not.toHaveBeenCalled()
	})

	test('imports history, starts the configured agent, updates status, and publishes final output', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			[
				'C1',
				[
					{ ts: '1.000001', user: 'U2', text: 'Original request' },
					{
						ts: '2.000001',
						thread_ts: '1.000001',
						user: 'U1',
						text: '<@UBOT> implement it',
						files: [
							{
								id: 'image',
								name: 'diagram.png',
								mimetype: 'image/png',
								size: 3,
								url_private: 'https://files.slack.com/diagram.png',
							},
						],
					},
				],
			],
		])
		const { runner, mocks } = await makeHarness(histories, {
			assistantParentID: 'msg_synthetic_compaction_continue',
		})
		expect(mocks.markReady).toHaveBeenCalledWith('/tmp/limitless-slack-test-ready', '/repo')
		const running = runEffect(
			runner.handleMention(mention('E1', '2.000001', '<@UBOT> implement it')),
		)

		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		expect(mocks.prompt).not.toHaveBeenCalled()
		const promptBody = mocks.promptAsync.mock.calls[0]?.[0].body
		if (promptBody === undefined) throw new Error('missing OpenCode prompt body')
		expect(promptBody.agent).toBe('slack-agent')
		expect(promptBody).not.toHaveProperty('system')
		expect(promptBody.messageID).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u)
		expect(promptBody.tools).toEqual({ question: false, slack_status: true })
		expect(promptBody.parts.filter((part: { type: string }) => part.type === 'file')).toHaveLength(
			1,
		)
		expect(mocks.fetch).toHaveBeenCalledWith(
			'https://files.slack.com/diagram.png',
			expect.objectContaining({ headers: { Authorization: 'Bearer xoxb-test' } }),
		)

		await runEffect(runner.updateStatus('session-1', 'Running tests'))
		await runEffect(runner.updateStatus('session-1', 'Running tests'))
		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({
				markdown_text: '🧠 *Thinking…*\n> Running tests\n> Running tests',
				ts: 'status-1',
			}),
		)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await running
		expect(mocks.update).toHaveBeenLastCalledWith(
			expect.objectContaining({
				markdown_text: '🧠 *Thinking…*\n> Running tests\n> Running tests',
				ts: 'status-1',
			}),
		)
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: '**Final answer**' }),
		)
		await runEffect(runner.stop)
		expect(mocks.clearReady).toHaveBeenCalledTimes(2)
	})

	test('imports messages before a mention from oldest to newest', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			[
				'C1',
				[
					{ ts: '4.000001', thread_ts: '1.000001', user: 'U1', text: '<@UBOT> respond' },
					{ ts: '3.000001', thread_ts: '1.000001', user: 'U3', text: 'third' },
					{ ts: '1.000001', user: 'U1', text: 'first' },
					{ ts: '2.000001', thread_ts: '1.000001', user: 'U2', text: 'second' },
				],
			],
		])
		const { runner, mocks } = await makeHarness(histories)
		const running = runEffect(runner.handleMention(mention('E1', '4.000001', '<@UBOT> respond')))

		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		const imported = mocks.promptAsync.mock.calls[0]?.[0].body.parts
			.filter((part) => part.type === 'text')
			.map((part) => part.text?.split('\n')[1])
		expect(imported).toEqual(['first', 'second', 'third', 'respond'])
		expect(mocks.prompt).not.toHaveBeenCalled()
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await running
		await runEffect(runner.stop)
	})

	test('retries a batched human message when a later prompt launch fails', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' }]],
		])
		let launches = 0
		const { runner, mocks } = await makeHarness(histories, {
			promptAsync: () => {
				launches += 1
				return launches === 2
					? Promise.reject(new Error('prompt unavailable'))
					: Promise.resolve({ data: undefined })
			},
		})
		const first = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> first', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await first

		histories.set('C1', [
			{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' },
			{ ts: '3.0', thread_ts: '1.0', user: 'U2', text: 'do not lose this' },
			{ ts: '4.0', thread_ts: '1.0', user: 'UBOT', text: 'prior bot output' },
			{ ts: '5.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> second' },
		])
		await runEffect(runner.handleMention(mention('E2', '5.0', '<@UBOT> second', 'C1', '1.0')))

		histories.get('C1')?.push({
			ts: '6.0',
			thread_ts: '1.0',
			user: 'U1',
			text: '<@UBOT> retry',
		})
		const retry = runEffect(
			runner.handleMention(mention('E3', '6.0', '<@UBOT> retry', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(3))
		const retriedParts = mocks.promptAsync.mock.calls[2]?.[0].body.parts
		expect(retriedParts?.some((part) => part.text?.includes('do not lose this'))).toBe(true)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await retry
		await runEffect(runner.stop)
	})

	test('keeps the previous trace intact when a continuation post fails', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> work', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		for (let index = 0; index < 11; index += 1)
			await runEffect(runner.updateStatus('session-1', `${index}-${'x'.repeat(995)}`))

		mocks.postMessage.mockRejectedValueOnce(new Error('temporary Slack failure'))
		const failed = await runEffect(
			runner.updateStatus('session-1', `11-${'x'.repeat(995)}`).pipe(Effect.flip),
		)
		expect(failed._tag).toBe('SlackIntegrationError')
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await running
		const trace = mocks.update.mock.calls.at(-1)?.[0].markdown_text
		expect(trace).toContain(`> 10-${'x'.repeat(995)}`)
		expect(trace).not.toContain(`> 11-${'x'.repeat(995)}`)
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: '**Final answer**' }),
		)
		await runEffect(runner.stop)
	})

	test('continues a full thinking trace and appends the final answer to its latest message', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' }]],
		])
		const { runner, mocks } = await makeHarness(histories, {
			assistantText: `**Final answer** ${'y'.repeat(13_000)}`,
		})
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> work', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))

		for (let index = 0; index < 13; index += 1)
			await runEffect(runner.updateStatus('session-1', `${index}-${'x'.repeat(995)}`))

		expect(mocks.postMessage).toHaveBeenCalledTimes(2)
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				markdown_text: expect.stringMatching(/^🧠 \*Thinking…\*\n> /u),
			}),
		)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await running
		expect(mocks.update).toHaveBeenLastCalledWith(expect.objectContaining({ ts: 'status-2' }))
		expect(mocks.postMessage).toHaveBeenCalledTimes(4)
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: expect.stringContaining('y') }),
		)
		await runEffect(runner.stop)
	})

	test('steers same-thread mentions while allowing different threads to run in parallel', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' }]],
			['C2', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> other' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		const fixedClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
		const first = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> first', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))

		histories.set('C1', [
			{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' },
			{ ts: '2.5', thread_ts: '1.0', user: 'U2', text: 'between mentions' },
			{ ts: '3.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> second' },
		])
		const second = runEffect(
			runner.handleMention(mention('E2', '3.0', '<@UBOT> second', 'C1', '1.0')),
		)
		await second
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(2))
		expect(
			(mocks.promptAsync.mock.calls[1]?.[0].body.messageID ?? '') >
				(mocks.promptAsync.mock.calls[0]?.[0].body.messageID ?? ''),
		).toBe(true)
		expect(
			mocks.promptAsync.mock.calls[1]?.[0].body.parts
				.filter((part) => part.type === 'text')
				.map((part) => part.text?.split('\n')[1]),
		).toEqual(['between mentions', 'second'])
		fixedClock.mockRestore()
		expect(mocks.create).toHaveBeenCalledTimes(1)
		await runEffect(runner.updateStatus('session-1', 'Read the follow-up'))
		expect(mocks.update).toHaveBeenLastCalledWith(
			expect.objectContaining({
				markdown_text: '🧠 *Thinking…*\n> Read the follow-up',
				ts: 'status-2',
			}),
		)
		const other = runEffect(
			runner.handleMention(mention('E3', '2.0', '<@UBOT> other', 'C2', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(3))
		expect(mocks.create).toHaveBeenCalledTimes(2)

		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await first
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-2' } }),
		)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await other
		await runEffect(runner.stop)
	})

	test('restarts an idle run when its latest steering message was not consumed', async () => {
		let resolveWake!: (response: { data: undefined }) => void
		const wakeResponse = new Promise<{ data: undefined }>((resolve) => {
			resolveWake = resolve
		})
		let promptCalls = 0
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' }]],
		])
		const { runner, mocks } = await makeHarness(histories, {
			assistantParentID: ({ call, latestPromptID }) =>
				call === 1 ? 'msg_00000000000100000000000000' : (latestPromptID ?? 'missing'),
			promptAsync: () => {
				promptCalls += 1
				return promptCalls === 3 ? wakeResponse : Promise.resolve({ data: undefined })
			},
		})
		await runEffect(runner.handleMention(mention('E1', '2.0', '<@UBOT> first', 'C1', '1.0')))
		histories.set('C1', [
			{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' },
			{ ts: '3.0', thread_ts: '1.0', user: 'U2', text: 'new context' },
			{ ts: '4.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> follow up' },
		])
		await runEffect(runner.handleMention(mention('E2', '4.0', '<@UBOT> follow up', 'C1', '1.0')))
		expect(mocks.promptAsync).toHaveBeenCalledTimes(2)

		const firstIdle = runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(3))
		const staleIdle = runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'session.status',
				properties: { sessionID: 'session-1', status: { type: 'busy' } },
			}),
		)
		resolveWake({ data: undefined })
		await Promise.all([firstIdle, staleIdle])
		expect(mocks.promptAsync).toHaveBeenCalledTimes(3)
		expect(mocks.postMessage).toHaveBeenCalledTimes(2)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: '**Final answer**' }),
		)
		await runEffect(runner.stop)
	})

	test('starts a new turn for a mention that arrives during final publication', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		await runEffect(runner.handleMention(mention('E1', '2.0', '<@UBOT> first', 'C1', '1.0')))
		let resolveFinal!: (response: { ok: boolean; ts: string }) => void
		const finalPost = new Promise<{ ok: boolean; ts: string }>((resolve) => {
			resolveFinal = resolve
		})
		mocks.postMessage.mockImplementationOnce(() => finalPost)
		const finalizing = runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await vi.waitFor(() => expect(mocks.postMessage).toHaveBeenCalledTimes(2))

		histories.set('C1', [
			{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' },
			{ ts: '3.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> next' },
		])
		const next = runEffect(runner.handleMention(mention('E2', '3.0', '<@UBOT> next', 'C1', '1.0')))
		resolveFinal({ ok: true, ts: 'final-1' })
		await finalizing
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(2))
		await next
		expect(mocks.create).toHaveBeenCalledTimes(1)
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: '🧠 *Thinking…*' }),
		)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await runEffect(runner.stop)
	})

	test('ignores an idle invalidated by busy during response retrieval', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		await runEffect(runner.handleMention(mention('E1', '2.0', '<@UBOT> first', 'C1', '1.0')))
		histories.set('C1', [
			{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' },
			{ ts: '3.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> follow up' },
		])
		await runEffect(runner.handleMention(mention('E2', '3.0', '<@UBOT> follow up', 'C1', '1.0')))
		const parentID = mocks.promptAsync.mock.calls[1]?.[0].body.messageID
		let resolveMessages!: (response: {
			data: Array<{
				info: { id: string; parentID: string | undefined; role: string; time: { created: number } }
				parts: Array<{ ignored: boolean; text: string; type: string }>
			}>
		}) => void
		const delayedMessages = new Promise<{
			data: Array<{
				info: { id: string; parentID: string | undefined; role: string; time: { created: number } }
				parts: Array<{ ignored: boolean; text: string; type: string }>
			}>
		}>((resolve) => {
			resolveMessages = resolve
		})
		mocks.messages.mockImplementationOnce(() => delayedMessages)
		const staleIdle = runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await vi.waitFor(() => expect(mocks.messages).toHaveBeenCalledTimes(1))
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'session.status',
				properties: { sessionID: 'session-1', status: { type: 'busy' } },
			}),
		)
		resolveMessages({
			data: [
				{
					info: {
						id: 'msg_ffffffffffffffffffffffffff',
						parentID,
						role: 'assistant',
						time: { created: Date.now() },
					},
					parts: [{ ignored: false, text: '**Final answer**', type: 'text' }],
				},
			],
		})
		await staleIdle
		expect(mocks.postMessage).toHaveBeenCalledTimes(2)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: '**Final answer**' }),
		)
		await runEffect(runner.stop)
	})

	test('cancels out of band and denies permission prompts for active child sessions', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> work', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'session.created',
				properties: { info: { id: 'child-1', parentID: 'session-1' } },
			}),
		)
		expect(await runEffect(runner.shouldDenyPermission('child-1'))).toBe(true)
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'session.status',
				properties: { sessionID: 'session-1', status: { type: 'busy' } },
			}),
		)
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'permission.asked',
				properties: { id: 'permission-1', sessionID: 'child-1' },
			}),
		)
		expect(mocks.rejectPermission).toHaveBeenCalledWith({
			body: { response: 'reject' },
			path: { id: 'child-1', permissionID: 'permission-1' },
			throwOnError: true,
		})

		await runEffect(runner.handleMention(mention('E2', '2.1', '<@UBOT> cancel', 'C1', '1.0')))
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'session.status',
				properties: { sessionID: 'session-1', status: { type: 'idle' } },
			}),
		)
		await running
		expect(mocks.abort).toHaveBeenCalledTimes(1)
		expect(mocks.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				markdown_text: expect.stringContaining('Cancelled by <@U1>.'),
			}),
		)
		expect(await runEffect(runner.shouldDenyPermission('child-1'))).toBe(false)
		await runEffect(runner.stop)
	})

	test('does not launch a turn cancelled while an image is downloading', async () => {
		let resolveFetch!: (response: Response) => void
		const fetchResponse = new Promise<Response>((resolve) => {
			resolveFetch = resolve
		})
		const histories = new Map<string, Array<SlackMessage>>([
			[
				'C1',
				[
					{
						ts: '2.0',
						thread_ts: '1.0',
						user: 'U1',
						text: '<@UBOT> inspect this',
						files: [
							{
								id: 'F1',
								mimetype: 'image/png',
								size: 3,
								url_private: 'https://files.slack.com/files-pri/F1/image.png',
							},
						],
					},
				],
			],
		])
		const { runner, mocks } = await makeHarness(histories, {
			fetch: () => fetchResponse,
		})
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> inspect this', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
		await runEffect(runner.handleMention(mention('E2', '2.1', '<@UBOT> cancel', 'C1', '1.0')))
		await running
		expect(mocks.promptAsync).not.toHaveBeenCalled()
		expect(mocks.abort).not.toHaveBeenCalled()
		expect(mocks.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				markdown_text: expect.stringContaining('Cancelled by <@U1>.'),
			}),
		)
		resolveFetch(
			new Response(new Uint8Array([1, 2, 3]), {
				status: 200,
				headers: { 'content-length': '3' },
			}),
		)
		await runEffect(runner.stop)
	})

	test('aborts and settles even when the cancellation notice cannot be posted', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		await runEffect(runner.handleMention(mention('E1', '2.0', '<@UBOT> work', 'C1', '1.0')))
		mocks.postMessage.mockRejectedValueOnce(new Error('Slack unavailable'))
		await runEffect(runner.handleMention(mention('E2', '3.0', '<@UBOT> cancel', 'C1', '1.0')))
		expect(mocks.abort).toHaveBeenCalledTimes(1)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		expect(await runEffect(runner.shouldDenyPermission('session-1'))).toBe(false)
		await runEffect(runner.stop)
	})

	test('cancels initial session setup before a turn becomes active', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' }]],
		])
		const { runner, mocks } = await makeHarness(histories, {
			create: ({ signal }) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
				}),
		})
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> work', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
		await runEffect(runner.handleMention(mention('E2', '2.1', '<@UBOT> cancel', 'C1', '1.0')))
		await running
		expect(mocks.promptAsync).not.toHaveBeenCalled()
		expect(mocks.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				markdown_text: 'Cancelled by <@U1>.',
			}),
		)
		await runEffect(runner.stop)
	})

	test('preserves the thinking trace when initial session setup fails', async () => {
		const histories = new Map<string, Array<SlackMessage>>()
		const { runner, mocks } = await makeHarness(histories, {
			create: () => Promise.reject(new Error('session unavailable')),
		})

		await runEffect(runner.handleMention(mention('E1', '2.0', '<@UBOT> work', 'C1', '1.0')))
		expect(mocks.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ markdown_text: '🧠 *Thinking…*' }),
		)
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				markdown_text: expect.stringMatching(/^OpenCode could not create a session/u),
			}),
		)
		await runEffect(runner.stop)
	})

	test('keeps cancellation as the terminal status when a status update is in flight', async () => {
		let resolveStatus!: (response: { ok: boolean }) => void
		const statusResponse = new Promise<{ ok: boolean }>((resolve) => {
			resolveStatus = resolve
		})
		let updateCount = 0
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' }]],
		])
		const { runner, mocks } = await makeHarness(histories, {
			update: () => {
				updateCount += 1
				return updateCount === 1 ? statusResponse : Promise.resolve({ ok: true })
			},
		})
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> work', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'session.status',
				properties: { sessionID: 'session-1', status: { type: 'busy' } },
			}),
		)
		const status = runEffect(runner.updateStatus('session-1', 'Still working'))
		await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1))
		const cancelling = runEffect(
			runner.handleMention(mention('E2', '2.1', '<@UBOT> cancel', 'C1', '1.0')),
		)
		resolveStatus({ ok: true })
		await Promise.all([status, cancelling])
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'session.status',
				properties: { sessionID: 'session-1', status: { type: 'idle' } },
			}),
		)
		await running
		expect(mocks.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				markdown_text: expect.stringContaining('Cancelled by <@U1>.'),
			}),
		)
		const rejected = await runEffect(runner.updateStatus('session-1', 'Too late').pipe(Effect.flip))
		expect(rejected._tag).toBe('SlackIntegrationError')
		await runEffect(runner.stop)
	})

	test('aborts an accepting prompt and clears a same-thread pending mention', async () => {
		let resolvePrompt!: (response: { data: undefined }) => void
		const promptResponse = new Promise<{ data: undefined }>((resolve) => {
			resolvePrompt = resolve
		})
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' }]],
		])
		const { runner, mocks } = await makeHarness(histories, {
			promptAsync: () => promptResponse,
		})
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> work', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		histories.set('C1', [
			{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' },
			{ ts: '3.0', thread_ts: '1.0', user: 'U2', text: '<@UBOT> more work' },
		])
		const queued = runEffect(
			runner.handleMention(mention('E2', '3.0', '<@UBOT> more work', 'C1', '1.0')),
		)
		const cancelling = runEffect(
			runner.handleMention(mention('E3', '4.0', '<@UBOT> cancel', 'C1', '1.0')),
		)
		resolvePrompt({ data: undefined })
		await Promise.all([running, queued, cancelling])
		expect(mocks.promptAsync).toHaveBeenCalledTimes(1)
		expect(mocks.postMessage).toHaveBeenCalledTimes(2)
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: 'Cancelled by <@U1>.' }),
		)
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'session.status',
				properties: { sessionID: 'session-1', status: { type: 'busy' } },
			}),
		)
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'session.status',
				properties: { sessionID: 'session-1', status: { type: 'idle' } },
			}),
		)
		expect(mocks.abort).toHaveBeenCalledTimes(3)
		expect(mocks.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				markdown_text: expect.stringContaining('Cancelled by <@U1>.'),
			}),
		)
		await runEffect(runner.handleMention(mention('E-old', '3.5', '<@UBOT> cancel', 'C1', '1.0')))
		histories.set('C1', [
			{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' },
			{ ts: '3.0', thread_ts: '1.0', user: 'U2', text: '<@UBOT> more work' },
			{ ts: '3.8', thread_ts: '1.0', user: 'U2', text: 'must stay cancelled' },
			{ ts: '4.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> cancel' },
			{ ts: '5.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> fresh request' },
		])
		await runEffect(
			runner.handleMention(mention('E4', '5.0', '<@UBOT> fresh request', 'C1', '1.0')),
		)
		const freshParts = mocks.promptAsync.mock.calls[1]?.[0].body.parts
		expect(freshParts?.some((part) => part.text?.includes('more work'))).toBe(false)
		expect(freshParts?.some((part) => part.text?.includes('must stay cancelled'))).toBe(false)
		expect(freshParts?.some((part) => part.text?.includes('fresh request'))).toBe(true)
		expect(mocks.create).toHaveBeenCalledTimes(1)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await runEffect(runner.stop)
	})

	test('downloads a repeated Slack file ID only once per imported delta', async () => {
		const duplicateFile = {
			id: 'F1',
			mimetype: 'image/png',
			size: 3,
			url_private: 'https://files.slack.com/files-pri/F1/image.png',
		}
		const histories = new Map<string, Array<SlackMessage>>([
			[
				'C1',
				[
					{ ts: '1.0', user: 'U2', text: 'first', files: [duplicateFile] },
					{
						ts: '2.0',
						thread_ts: '1.0',
						user: 'U1',
						text: '<@UBOT> inspect',
						files: [duplicateFile],
					},
				],
			],
		])
		const { runner, mocks } = await makeHarness(histories)
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> inspect', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		expect(mocks.fetch).toHaveBeenCalledTimes(1)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await running
		await runEffect(runner.stop)
	})

	test('stops reading a chunked Slack image after the byte limit', async () => {
		let pulls = 0
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1
				if (pulls > 20) {
					controller.close()
					return
				}
				controller.enqueue(new Uint8Array(1024 * 1024))
			},
		})
		const histories = new Map<string, Array<SlackMessage>>([
			[
				'C1',
				[
					{
						ts: '2.0',
						thread_ts: '1.0',
						user: 'U1',
						text: '<@UBOT> inspect',
						files: [
							{
								id: 'F1',
								mimetype: 'image/png',
								url_private: 'https://files.slack.com/files-pri/F1/image.png',
							},
						],
					},
				],
			],
		])
		const { runner, mocks } = await makeHarness(histories, {
			fetch: () => Promise.resolve(new Response(stream, { status: 200 })),
		})
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> inspect', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		expect(pulls).toBeLessThanOrEqual(12)
		const promptBody = mocks.promptAsync.mock.calls[0]?.[0].body
		expect(promptBody?.parts.filter((part) => part.type === 'file')).toHaveLength(0)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await running
		await runEffect(runner.stop)
	})

	test('waits for idle after a recoverable context overflow', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> work', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'session.error',
				properties: { sessionID: 'session-1', error: { name: 'ContextOverflowError' } },
			}),
		)
		expect(mocks.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ markdown_text: expect.stringContaining('reported an error') }),
		)
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'session.status',
				properties: { sessionID: 'session-1', status: { type: 'idle' } },
			}),
		)
		await running
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: expect.stringContaining('**Final answer**') }),
		)
		await runEffect(runner.stop)
	})

	test('settles immediately when OpenCode reports a terminal asynchronous error', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> work', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'session.error',
				properties: { sessionID: 'session-1', error: { name: 'UnknownError' } },
			}),
		)
		await running
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: expect.stringContaining('reported an error') }),
		)
		await runEffect(runner.stop)
	})

	test('reports a context overflow as terminal when the completed assistant has an error', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' }]],
		])
		const { runner, mocks } = await makeHarness(histories, {
			assistantError: 'ContextOverflowError',
		})
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> work', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'session.error',
				properties: { sessionID: 'session-1', error: { name: 'ContextOverflowError' } },
			}),
		)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await running
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: expect.stringContaining('reported an error') }),
		)
		await runEffect(runner.stop)
	})

	test('drops a deleted OpenCode session so the next mention creates a fresh one', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		const first = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> first', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'session.deleted',
				properties: { info: { id: 'session-1' } },
			}),
		)
		await first
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: expect.stringContaining('was deleted') }),
		)

		histories.set('C1', [
			{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' },
			{ ts: '3.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> retry' },
		])
		const second = runEffect(
			runner.handleMention(mention('E2', '3.0', '<@UBOT> retry', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(2))
		expect(mocks.create).toHaveBeenCalledTimes(2)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-2' } }),
		)
		await second
		await runEffect(runner.stop)
	})
})
