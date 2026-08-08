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
		assistantParentID?: string
		assistantText?: string
		fetch?: typeof globalThis.fetch
		create?: (args: { signal?: AbortSignal }) => Promise<{ data: { id: string } }>
		promptAsync?: (args: {
			body: {
				agent: string
				messageID: string
				tools: Record<string, boolean>
				parts: Array<{ type: string }>
			}
		}) => Promise<{ data: undefined }>
		update?: (args: Record<string, unknown>) => Promise<{ ok: boolean }>
	} = {},
) {
	let sessionCounter = 0
	let slackMessageCounter = 0
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
			body: {
				agent: string
				messageID: string
				tools: Record<string, boolean>
				parts: Array<{ type: string }>
			}
		}) => behavior.promptAsync?.(_args) ?? Promise.resolve({ data: undefined }),
	)
	const abort = vi.fn(() => Promise.resolve({ data: true }))
	const rejectPermission = vi.fn(() => Promise.resolve({ data: true }))
	const messages = vi.fn(() => {
		const parentID = promptAsync.mock.calls.at(-1)?.[0].body.messageID
		return Promise.resolve({
			data: [
				{
					info: {
						id: 'msg_ffffffffffffffffffffffffff',
						role: 'assistant',
						parentID: behavior.assistantParentID ?? parentID,
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
		expect(mocks.prompt).toHaveBeenCalledTimes(1)
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
		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({ text: 'Running tests', ts: 'status-1' }),
		)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await running
		expect(mocks.update).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: '**Final answer**', ts: 'status-1' }),
		)
		await runEffect(runner.stop)
		expect(mocks.clearReady).toHaveBeenCalledTimes(2)
	})

	test('serializes turns in one thread while allowing different threads to start in parallel', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' }]],
			['C2', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> other' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		const first = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> first', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))

		histories.set('C1', [
			{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' },
			{ ts: '3.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> second' },
		])
		const second = runEffect(
			runner.handleMention(mention('E2', '3.0', '<@UBOT> second', 'C1', '1.0')),
		)
		const other = runEffect(
			runner.handleMention(mention('E3', '2.0', '<@UBOT> other', 'C2', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(2))
		expect(mocks.create).toHaveBeenCalledTimes(2)

		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await first
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(3))
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-2' } }),
		)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		await Promise.all([second, other])
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
		expect(mocks.update).toHaveBeenLastCalledWith(
			expect.objectContaining({ text: 'Cancelled by <@U1>.' }),
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
		expect(mocks.update).toHaveBeenLastCalledWith(
			expect.objectContaining({ text: 'Cancelled by <@U1>.' }),
		)
		resolveFetch(
			new Response(new Uint8Array([1, 2, 3]), {
				status: 200,
				headers: { 'content-length': '3' },
			}),
		)
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
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ text: 'Cancelled by <@U1>.' }),
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
		expect(mocks.update).toHaveBeenLastCalledWith(
			expect.objectContaining({ text: 'Cancelled by <@U1>.' }),
		)
		const rejected = await runEffect(runner.updateStatus('session-1', 'Too late').pipe(Effect.flip))
		expect(rejected._tag).toBe('SlackIntegrationError')
		await runEffect(runner.stop)
	})

	test('aborts a turn cancelled while OpenCode is accepting the prompt', async () => {
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
		const cancelling = runEffect(
			runner.handleMention(mention('E2', '2.1', '<@UBOT> cancel', 'C1', '1.0')),
		)
		resolvePrompt({ data: undefined })
		await cancelling
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
		await running
		expect(mocks.abort).toHaveBeenCalledTimes(1)
		expect(mocks.update).toHaveBeenLastCalledWith(
			expect.objectContaining({ text: 'Cancelled by <@U1>.' }),
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
		expect(mocks.update).not.toHaveBeenCalledWith(
			expect.objectContaining({ text: expect.stringContaining('reported an error') }),
		)
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'session.status',
				properties: { sessionID: 'session-1', status: { type: 'idle' } },
			}),
		)
		await running
		expect(mocks.update).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: '**Final answer**' }),
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
		expect(mocks.update).toHaveBeenLastCalledWith(
			expect.objectContaining({ text: expect.stringContaining('reported an error') }),
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
		expect(mocks.update).toHaveBeenLastCalledWith(
			expect.objectContaining({ text: expect.stringContaining('reported an error') }),
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
		expect(mocks.update).toHaveBeenLastCalledWith(
			expect.objectContaining({ text: expect.stringContaining('was deleted') }),
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
