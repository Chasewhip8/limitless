import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Data, Effect } from 'effect'
import { describe, expect, test, vi } from 'vitest'
import { validateSlackImage } from '../integrations/slack/image'
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
class TestClientError extends Data.TaggedError('TestClientError')<{ readonly cause: unknown }> {}
const VALID_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
	'base64',
)

type TestPromptInput = {
	readonly sessionID: string
	readonly id?: string
	readonly text: string
	readonly files?: ReadonlyArray<{ readonly uri: string; readonly name?: string }>
}

type EventRunner = {
	readonly handleOpenCodeEvent: (event: unknown) => Effect.Effect<void>
}

let assistantEventCounter = 0

async function emitOpenCodeEvent(runner: EventRunner, type: string, data: unknown) {
	await runEffect(runner.handleOpenCodeEvent({ type, data }))
}

async function completeTurn(
	runner: EventRunner,
	sessionID: string,
	options: {
		readonly assistantID?: string
		readonly failed?: boolean
		readonly finish?: string
		readonly inboxID?: string
		readonly text?: string
	} = {},
) {
	const assistantID =
		options.assistantID ?? `msg_aaaaaaaaaaaa${String(++assistantEventCounter).padStart(14, '0')}`
	await emitOpenCodeEvent(runner, 'session.execution.started', { sessionID })
	if (options.inboxID !== undefined)
		await emitOpenCodeEvent(runner, 'session.inbox.delivered', {
			sessionID,
			inboxID: options.inboxID,
		})
	await emitOpenCodeEvent(runner, 'session.step.started', {
		sessionID,
		assistantMessageID: assistantID,
	})
	await emitOpenCodeEvent(runner, 'session.text.ended', {
		sessionID,
		assistantMessageID: assistantID,
		ordinal: 0,
		text: options.text ?? '**Final answer**',
	})
	await emitOpenCodeEvent(
		runner,
		options.failed === true ? 'session.step.failed' : 'session.step.ended',
		{
			sessionID,
			assistantMessageID: assistantID,
			finish: options.finish ?? 'stop',
		},
	)
	await emitOpenCodeEvent(runner, 'session.execution.succeeded', { sessionID })
}

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
		fetch?: typeof globalThis.fetch
		filesUploadV2?: (args: Record<string, unknown>) => Promise<unknown>
		getUploadURLExternal?: (args: Record<string, unknown>) => Promise<unknown>
		completeUploadExternal?: (args: Record<string, unknown>) => Promise<unknown>
		fileInfo?: (args: { file: string }) => Promise<unknown>
		create?: (args: { signal: AbortSignal }) => Promise<{ id: string }>
		promptAsync?: (args: TestPromptInput & { readonly signal: AbortSignal }) => Promise<void>
		wait?: () => Promise<void>
		update?: (args: Record<string, unknown>) => Promise<{ ok: boolean }>
	} = {},
) {
	let sessionCounter = 0
	let slackMessageCounter = 0
	const latestPromptBySession = new Map<string, string>()
	const create = vi.fn((_input: { title?: string; agent?: string }) =>
		Effect.tryPromise({
			try: (signal) =>
				behavior.create?.({ signal }).then((response) => {
					sessionCounter += 1
					return response
				}) ?? Promise.resolve({ id: `session-${++sessionCounter}` }),
			catch: (cause) => new TestClientError({ cause }),
		}),
	)
	const promptAsync = vi.fn((input: TestPromptInput) =>
		Effect.tryPromise({
			try: async (signal) => {
				latestPromptBySession.set(input.sessionID, input.id ?? '')
				await behavior.promptAsync?.({ ...input, signal })
			},
			catch: (cause) => new TestClientError({ cause }),
		}),
	)
	const abort = vi.fn(() => Effect.void)
	const wait = vi.fn(() =>
		Effect.tryPromise({
			try: () => behavior.wait?.() ?? Promise.resolve(),
			catch: (cause) => new TestClientError({ cause }),
		}),
	)
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
	const fileInfo = vi.fn(
		behavior.fileInfo ?? (() => Promise.resolve({ ok: false, error: 'file_not_found' })),
	)
	const filesUploadV2 = vi.fn(
		behavior.filesUploadV2 ?? (() => Promise.resolve({ ok: true, files: [] })),
	)
	let uploadTicket = 0
	const getUploadURLExternal = vi.fn(
		behavior.getUploadURLExternal ??
			(() =>
				Promise.resolve({
					ok: true,
					file_id: `F-OUT-${++uploadTicket}`,
					upload_url: `https://files.slack.com/upload/${uploadTicket}`,
				})),
	)
	const completeUploadExternal = vi.fn(
		behavior.completeUploadExternal ?? (() => Promise.resolve({ ok: true, files: [] })),
	)
	const slackClient = {
		auth: { test: () => Promise.resolve({ ok: true, user_id: 'UBOT', team_id: 'T1' }) },
		chat: { postMessage, update },
		conversations: { replies },
		files: { info: fileInfo, uploadV2: filesUploadV2 },
	}
	const uploadClient = {
		files: { completeUploadExternal, getUploadURLExternal, uploadV2: filesUploadV2 },
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
					new Response(VALID_PNG, {
						status: 200,
						headers: { 'content-length': String(VALID_PNG.byteLength) },
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
				session: { create, prompt: promptAsync, interrupt: abort, wait } as never,
			},
			{
				env: {
					LIMITLESS_SLACK_SERVICE: '1',
					SLACK_BOT_TOKEN: 'xoxb-test',
					SLACK_APP_TOKEN: 'xapp-test',
				},
				resolveDirectory: (directory) => Promise.resolve(directory),
				makeApp,
				makeUploadClient: () => uploadClient as never,
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
			fileInfo,
			filesUploadV2,
			getUploadURLExternal,
			completeUploadExternal,
			markReady,
			postMessage,
			promptAsync,
			replies,
			update,
			wait,
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

	test('prioritizes triggering attachments and enforces count and metadata size limits', () => {
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

	test('reserves the aggregate text budget for triggering attachments first', () => {
		const textFile = (id: string) => ({
			id,
			name: `${id}.md`,
			mimetype: 'text/markdown',
			size: 512 * 1024,
			url_private: `https://files.slack.com/${id}.md`,
		})
		const messages: Array<SlackMessage> = [
			{ ts: '1.0', files: [textFile('old-one'), textFile('old-two')] },
			{ ts: '2.0', files: [textFile('trigger')] },
		]

		expect([...selectSlackImageIDs(messages, '2.0')]).toEqual(['trigger', 'old-one'])
	})

	test('rejects oversized decoded image dimensions before attachment', async () => {
		const oversized = Buffer.from(VALID_PNG)
		oversized.writeUInt32BE(10_001, 16)
		expect(
			await runEffect(validateSlackImage(oversized, 'image/png', new AbortController().signal)),
		).toBe(false)
	})

	test('rejects image bytes that contradict the declared MIME type', async () => {
		expect(
			await runEffect(validateSlackImage(VALID_PNG, 'image/jpeg', new AbortController().signal)),
		).toBe(false)
	})
})

describe('Slack bridge runner', () => {
	test('queues a readable file snapshot and uploads it after the final text', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'limitless-slack-outbound-'))
		const filePath = path.join(directory, 'report.md')
		await writeFile(filePath, 'first version')
		try {
			const histories = new Map<string, Array<SlackMessage>>([
				['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> send it' }]],
			])
			const { runner, mocks } = await makeHarness(histories)
			const running = runEffect(
				runner.handleMention(mention('E1', '2.0', '<@UBOT> send it', 'C1', '1.0')),
			)
			await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))

			const queued = await runEffect(runner.attachFile('session-1', filePath, directory))
			expect(queued).toMatchObject({
				ok: true,
				filename: 'report.md',
				bytes: 13,
				status: 'queued',
			})
			await writeFile(filePath, 'second version')
			await completeTurn(runner, 'session-1')
			await running

			expect(mocks.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ markdown_text: '**Final answer**' }),
			)
			expect(mocks.getUploadURLExternal).toHaveBeenCalledWith({
				filename: 'report.md',
				length: 13,
			})
			expect(mocks.fetch).toHaveBeenCalledWith(
				'https://files.slack.com/upload/1',
				expect.objectContaining({ method: 'POST', body: Buffer.from('first version') }),
			)
			expect(mocks.completeUploadExternal).toHaveBeenCalledWith(
				expect.objectContaining({ channel_id: 'C1', thread_ts: '1.0' }),
			)
			await runEffect(runner.stop)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	test('reattaching a path replaces its queued snapshot', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'limitless-slack-outbound-'))
		const filePath = path.join(directory, 'report.txt')
		try {
			await writeFile(filePath, 'one')
			const histories = new Map<string, Array<SlackMessage>>([
				['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> send it' }]],
			])
			const { runner, mocks } = await makeHarness(histories)
			const running = runEffect(
				runner.handleMention(mention('E1', '2.0', '<@UBOT> send it', 'C1', '1.0')),
			)
			await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
			await runEffect(runner.attachFile('session-1', filePath, directory))
			await writeFile(filePath, 'two')
			expect(await runEffect(runner.attachFile('session-1', filePath, directory))).toMatchObject({
				status: 'replaced',
			})
			await completeTurn(runner, 'session-1')
			await running
			expect(mocks.fetch).toHaveBeenCalledWith(
				'https://files.slack.com/upload/1',
				expect.objectContaining({ body: Buffer.from('two') }),
			)
			await runEffect(runner.stop)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	test('discards queued files when a Slack turn is cancelled', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'limitless-slack-outbound-'))
		const filePath = path.join(directory, 'cancelled.txt')
		await writeFile(filePath, 'do not send')
		try {
			const histories = new Map<string, Array<SlackMessage>>([
				['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' }]],
			])
			const { runner, mocks } = await makeHarness(histories)
			void runEffect(runner.handleMention(mention('E1', '2.0', '<@UBOT> work', 'C1', '1.0')))
			await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
			await runEffect(runner.attachFile('session-1', filePath, directory))
			await runEffect(runner.handleMention(mention('E2', '3.0', '<@UBOT> cancel', 'C1', '1.0')))
			await emitOpenCodeEvent(runner, 'session.execution.interrupted', {
				sessionID: 'session-1',
			})
			expect(mocks.getUploadURLExternal).not.toHaveBeenCalled()
			await runEffect(runner.stop)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	test('posts an explicit warning when a queued file upload fails', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'limitless-slack-outbound-'))
		const filePath = path.join(directory, 'failed.txt')
		await writeFile(filePath, 'cannot upload')
		try {
			const histories = new Map<string, Array<SlackMessage>>([
				['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> send it' }]],
			])
			const { runner, mocks } = await makeHarness(histories, {
				getUploadURLExternal: () => Promise.reject(new Error('upload unavailable')),
			})
			const running = runEffect(
				runner.handleMention(mention('E1', '2.0', '<@UBOT> send it', 'C1', '1.0')),
			)
			await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
			await runEffect(runner.attachFile('session-1', filePath, directory))
			await completeTurn(runner, 'session-1')
			await running
			expect(mocks.getUploadURLExternal).toHaveBeenCalledTimes(1)
			expect(mocks.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					markdown_text: expect.stringContaining('could not attach `failed.txt`'),
				}),
			)
			await runEffect(runner.stop)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	test('starts only in the activated service', async () => {
		const config = await runEffect(
			normalizeSlackConfig({ slack: { enable: true, repository: '/repo' } }),
		)
		const makeApp = vi.fn() as SlackAppFactory
		const inactive = await runEffect(
			createSlackRunner(
				config,
				{ session: {} as never },
				{
					env: {},
					resolveDirectory: (directory) => Promise.resolve(directory),
					makeApp,
				},
			),
		)
		await runEffect(inactive.start(() => Promise.resolve()))
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
		const { runner, mocks } = await makeHarness(histories)
		expect(mocks.markReady).toHaveBeenCalledWith('/tmp/limitless-slack-test-ready', '/repo')
		const running = runEffect(
			runner.handleMention(mention('E1', '2.000001', '<@UBOT> implement it')),
		)

		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		const promptInput = mocks.promptAsync.mock.calls[0]?.[0]
		if (promptInput === undefined) throw new Error('missing OpenCode prompt input')
		expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ agent: 'slack-agent' }))
		expect(promptInput.id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u)
		expect(promptInput.text).toContain('Original request')
		expect(promptInput.text).toContain('implement it')
		expect(promptInput.files).toHaveLength(1)
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
		await completeTurn(runner, 'session-1')
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

	test('attaches unread Markdown and PDF files to their imported Slack messages', async () => {
		const markdown = Buffer.from('# Design\n\nUse the bounded pipeline.\n')
		const pdf = Buffer.from('%PDF-1.7\nmock document')
		const histories = new Map<string, Array<SlackMessage>>([
			[
				'C1',
				[
					{
						ts: '1.0',
						user: 'U2',
						text: 'Design document',
						files: [
							{
								id: 'F-MD',
								name: 'design.md',
								mimetype: 'text/markdown; charset=utf-8',
								filetype: 'markdown',
								size: markdown.byteLength,
								url_private_download: 'https://files.slack.com/design.md',
							},
						],
					},
					{
						ts: '2.0',
						thread_ts: '1.0',
						user: 'U1',
						text: '<@UBOT> review both files',
						files: [
							{
								id: 'F-PDF',
								name: 'requirements.pdf',
								mimetype: 'application/pdf',
								size: pdf.byteLength,
								url_private: 'https://files.slack.com/requirements.pdf',
							},
						],
					},
				],
			],
		])
		const { runner, mocks } = await makeHarness(histories, {
			fetch: (input) =>
				Promise.resolve(
					new Response(String(input).endsWith('.md') ? markdown : pdf, { status: 200 }),
				),
		})
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> review both files', 'C1', '1.0')),
		)

		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		const promptInput = mocks.promptAsync.mock.calls[0]?.[0]
		if (promptInput === undefined) throw new Error('missing OpenCode prompt input')
		expect(promptInput.files).toEqual([
			{ name: 'design.md', uri: `data:text/plain;base64,${markdown.toString('base64')}` },
			{
				name: 'requirements.pdf',
				uri: `data:application/pdf;base64,${pdf.toString('base64')}`,
			},
		])
		expect(promptInput.text).toContain('Slack file attached: design.md (text/plain)')
		expect(promptInput.text).toContain('Slack file attached: requirements.pdf (application/pdf)')
		await completeTurn(runner, 'session-1')
		await running
		await runEffect(runner.stop)
	})

	test('resolves incomplete Slack file metadata before attaching a text file', async () => {
		const markdown = Buffer.from('# Retrieved through files.info\n')
		const histories = new Map<string, Array<SlackMessage>>([
			[
				'C1',
				[
					{
						ts: '2.0',
						thread_ts: '1.0',
						user: 'U1',
						text: '<@UBOT> inspect',
						files: [{ id: 'F1', name: null, title: 'notes.md', file_access: 'check_file_info' }],
					},
				],
			],
		])
		const { runner, mocks } = await makeHarness(histories, {
			fileInfo: () =>
				Promise.resolve({
					ok: true,
					file: {
						id: 'F1',
						name: null,
						title: 'notes.md',
						mimetype: 'text/plain',
						filetype: 'markdown',
						size: markdown.byteLength,
						url_private: 'https://files.slack.com/notes.md',
					},
				}),
			fetch: () => Promise.resolve(new Response(markdown, { status: 200 })),
		})
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> inspect', 'C1', '1.0')),
		)

		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		expect(mocks.fileInfo).toHaveBeenCalledWith({ file: 'F1' })
		expect(mocks.promptAsync.mock.calls[0]?.[0].files).toContainEqual(
			expect.objectContaining({ name: 'notes.md' }),
		)
		await completeTurn(runner, 'session-1')
		await running
		await runEffect(runner.stop)
	})

	test('resolves fallback metadata before reserving text budget for the triggering file', async () => {
		const content = Buffer.alloc(512 * 1024, 0x61)
		const fallback = (id: string) => ({ id, file_access: 'check_file_info' })
		const histories = new Map<string, Array<SlackMessage>>([
			[
				'C1',
				[
					{
						ts: '1.0',
						user: 'U2',
						text: 'Older files',
						files: [fallback('old-one'), fallback('old-two')],
					},
					{
						ts: '2.0',
						thread_ts: '1.0',
						user: 'U1',
						text: '<@UBOT> inspect mine',
						files: [fallback('trigger')],
					},
				],
			],
		])
		const { runner, mocks } = await makeHarness(histories, {
			fileInfo: ({ file }) =>
				Promise.resolve({
					ok: true,
					file: {
						id: file,
						name: `${file}.md`,
						mimetype: 'text/markdown',
						size: content.byteLength,
						url_private: `https://files.slack.com/${file}.md`,
					},
				}),
			fetch: () => Promise.resolve(new Response(content, { status: 200 })),
		})
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> inspect mine', 'C1', '1.0')),
		)

		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		expect(mocks.fileInfo.mock.calls.map(([input]) => input.file)).toEqual([
			'trigger',
			'old-one',
			'old-two',
		])
		const files = mocks.promptAsync.mock.calls[0]?.[0].files
		expect(files?.map((file) => file.name)).toEqual(['old-one.md', 'trigger.md'])
		await completeTurn(runner, 'session-1')
		await running
		await runEffect(runner.stop)
	})

	test('bounds metadata lookups without letting resolved unsupported stubs consume slots', async () => {
		const ids = ['U1', 'U2', 'U3', 'U4', 'VALID', 'U6', 'U7', 'U8', 'U9', 'U10']
		const histories = new Map<string, Array<SlackMessage>>([
			[
				'C1',
				[
					{
						ts: '2.0',
						thread_ts: '1.0',
						user: 'U1',
						text: '<@UBOT> inspect',
						files: ids.map((id) => ({ id, file_access: 'check_file_info' })),
					},
				],
			],
		])
		const { runner, mocks } = await makeHarness(histories, {
			fileInfo: ({ file }) =>
				Promise.resolve({
					ok: true,
					file: {
						id: file,
						name: file === 'VALID' ? 'valid.png' : `${file}.bin`,
						mimetype: file === 'VALID' ? 'image/png' : 'application/octet-stream',
						size: VALID_PNG.byteLength,
						url_private: `https://files.slack.com/${file}`,
					},
				}),
		})
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> inspect', 'C1', '1.0')),
		)

		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		expect(mocks.fileInfo).toHaveBeenCalledTimes(8)
		const files = mocks.promptAsync.mock.calls[0]?.[0].files
		expect(files?.map((file) => file.name)).toEqual(['valid.png'])
		await completeTurn(runner, 'session-1')
		await running
		await runEffect(runner.stop)
	})

	test('omits text attachments that are not valid UTF-8', async () => {
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
								name: 'invalid.md',
								mimetype: 'text/markdown',
								url_private: 'https://files.slack.com/invalid.md',
							},
						],
					},
				],
			],
		])
		const { runner, mocks } = await makeHarness(histories, {
			fetch: () => Promise.resolve(new Response(new Uint8Array([0xff, 0xfe]), { status: 200 })),
		})
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> inspect', 'C1', '1.0')),
		)

		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		const promptInput = mocks.promptAsync.mock.calls[0]?.[0]
		if (promptInput === undefined) throw new Error('missing OpenCode prompt input')
		expect(promptInput.files).toHaveLength(0)
		expect(promptInput.text).toContain(
			'Attachment omitted: Slack file invalid.md could not be imported',
		)
		await completeTurn(runner, 'session-1')
		await running
		await runEffect(runner.stop)
	})

	test('omits signature-valid images that cannot be decoded', async () => {
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
								name: 'truncated.png',
								mimetype: 'image/png',
								url_private: 'https://files.slack.com/truncated.png',
							},
						],
					},
				],
			],
		])
		const { runner, mocks } = await makeHarness(histories, {
			fetch: () =>
				Promise.resolve(
					new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
						status: 200,
					}),
				),
		})
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> inspect', 'C1', '1.0')),
		)

		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		const promptInput = mocks.promptAsync.mock.calls[0]?.[0]
		if (promptInput === undefined) throw new Error('missing OpenCode prompt input')
		expect(promptInput.files).toHaveLength(0)
		expect(promptInput.text).toContain(
			'Attachment omitted: Slack file truncated.png could not be imported',
		)
		await completeTurn(runner, 'session-1')
		await running
		await runEffect(runner.stop)
	})

	test('enforces the aggregate text attachment limit', async () => {
		const content = Buffer.alloc(400 * 1024, 0x61)
		const histories = new Map<string, Array<SlackMessage>>([
			[
				'C1',
				[
					{
						ts: '2.0',
						thread_ts: '1.0',
						user: 'U1',
						text: '<@UBOT> inspect',
						files: ['one', 'two', 'three'].map((name) => ({
							id: name,
							name: `${name}.md`,
							mimetype: 'text/markdown',
							size: content.byteLength,
							url_private: `https://files.slack.com/${name}.md`,
						})),
					},
				],
			],
		])
		const { runner, mocks } = await makeHarness(histories, {
			fetch: () => Promise.resolve(new Response(content, { status: 200 })),
		})
		const running = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> inspect', 'C1', '1.0')),
		)

		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		const promptInput = mocks.promptAsync.mock.calls[0]?.[0]
		if (promptInput === undefined) throw new Error('missing OpenCode prompt input')
		expect(promptInput.files).toHaveLength(2)
		expect(promptInput.text).toContain(
			'Slack attachment three.md beyond the per-turn attachment limits',
		)
		await completeTurn(runner, 'session-1')
		await running
		await runEffect(runner.stop)
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
		const imported = mocks.promptAsync.mock.calls[0]?.[0].text
		if (imported === undefined) throw new Error('missing OpenCode prompt text')
		expect(imported.indexOf('first')).toBeLessThan(imported.indexOf('second'))
		expect(imported.indexOf('second')).toBeLessThan(imported.indexOf('third'))
		expect(imported.indexOf('third')).toBeLessThan(imported.indexOf('respond'))
		await completeTurn(runner, 'session-1')
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
				return launches === 2 ? Promise.reject(new Error('prompt unavailable')) : Promise.resolve()
			},
		})
		const first = runEffect(
			runner.handleMention(mention('E1', '2.0', '<@UBOT> first', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		await completeTurn(runner, 'session-1')
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
		const retriedText = mocks.promptAsync.mock.calls[2]?.[0].text
		expect(retriedText).toContain('do not lose this')
		await completeTurn(runner, 'session-1')
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
		await completeTurn(runner, 'session-1')
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
		const { runner, mocks } = await makeHarness(histories)
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
		await completeTurn(runner, 'session-1', {
			text: `**Final answer** ${'y'.repeat(13_000)}`,
		})
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
			(mocks.promptAsync.mock.calls[1]?.[0].id ?? '') >
				(mocks.promptAsync.mock.calls[0]?.[0].id ?? ''),
		).toBe(true)
		const steeredText = mocks.promptAsync.mock.calls[1]?.[0].text
		expect(steeredText).toContain('between mentions')
		expect(steeredText).toContain('second')
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

		const latestPromptID = mocks.promptAsync.mock.calls[1]?.[0].id
		if (latestPromptID === undefined) throw new Error('missing latest prompt ID')
		await completeTurn(runner, 'session-1', {
			inboxID: latestPromptID,
		})
		await first
		await completeTurn(runner, 'session-2')
		await other
		await runEffect(runner.stop)
	})

	test('restarts an idle run when its latest steering message was not consumed', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		await runEffect(runner.handleMention(mention('E1', '2.0', '<@UBOT> first', 'C1', '1.0')))
		const firstPromptID = mocks.promptAsync.mock.calls[0]?.[0].id
		if (firstPromptID === undefined) throw new Error('missing first prompt ID')
		histories.set('C1', [
			{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' },
			{ ts: '3.0', thread_ts: '1.0', user: 'U2', text: 'new context' },
			{ ts: '4.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> follow up' },
		])
		await runEffect(runner.handleMention(mention('E2', '4.0', '<@UBOT> follow up', 'C1', '1.0')))
		expect(mocks.promptAsync).toHaveBeenCalledTimes(2)
		await emitOpenCodeEvent(runner, 'session.execution.started', { sessionID: 'session-1' })
		await emitOpenCodeEvent(runner, 'session.inbox.delivered', {
			sessionID: 'session-1',
			inboxID: firstPromptID,
		})
		const staleAssistantID = 'msg_aaaaaaaaaaaa00000000000001'
		await emitOpenCodeEvent(runner, 'session.step.started', {
			sessionID: 'session-1',
			assistantMessageID: staleAssistantID,
		})
		await emitOpenCodeEvent(runner, 'session.text.ended', {
			sessionID: 'session-1',
			assistantMessageID: staleAssistantID,
			ordinal: 0,
			text: 'Stale response',
		})
		await emitOpenCodeEvent(runner, 'session.step.ended', {
			sessionID: 'session-1',
			assistantMessageID: staleAssistantID,
			finish: 'stop',
		})
		await emitOpenCodeEvent(runner, 'session.execution.succeeded', { sessionID: 'session-1' })
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(3))
		expect(mocks.promptAsync.mock.calls[2]?.[0].text).toContain(
			'incorporate all preceding Slack messages',
		)
		const resumedPromptID = mocks.promptAsync.mock.calls[2]?.[0].id
		if (resumedPromptID === undefined) throw new Error('missing resumed prompt ID')
		await completeTurn(runner, 'session-1', {
			inboxID: resumedPromptID,
			text: 'Final response',
		})
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: 'Final response' }),
		)
		await runEffect(runner.stop)
	})

	test('delivers the response before a steering response without waiting for session idle', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		await runEffect(runner.handleMention(mention('E1', '2.0', '<@UBOT> first', 'C1', '1.0')))
		const firstPromptID = mocks.promptAsync.mock.calls[0]?.[0].id
		if (firstPromptID === undefined) throw new Error('missing first prompt ID')
		histories.set('C1', [
			{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' },
			{ ts: '3.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> follow up' },
		])
		await runEffect(runner.handleMention(mention('E2', '3.0', '<@UBOT> follow up', 'C1', '1.0')))
		const secondPromptID = mocks.promptAsync.mock.calls[1]?.[0].id
		if (secondPromptID === undefined) throw new Error('missing second prompt ID')
		await emitOpenCodeEvent(runner, 'session.execution.started', { sessionID: 'session-1' })
		await emitOpenCodeEvent(runner, 'session.inbox.delivered', {
			sessionID: 'session-1',
			inboxID: firstPromptID,
		})
		const firstAssistantID = 'msg_aaaaaaaaaaaa00000000000002'
		await emitOpenCodeEvent(runner, 'session.step.started', {
			sessionID: 'session-1',
			assistantMessageID: firstAssistantID,
		})
		await emitOpenCodeEvent(runner, 'session.text.ended', {
			sessionID: 'session-1',
			assistantMessageID: firstAssistantID,
			ordinal: 0,
			text: 'First response',
		})
		await emitOpenCodeEvent(runner, 'session.step.ended', {
			sessionID: 'session-1',
			assistantMessageID: firstAssistantID,
			finish: 'stop',
		})
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: 'First response' }),
		)
		await emitOpenCodeEvent(runner, 'session.step.ended', {
			sessionID: 'session-1',
			assistantMessageID: firstAssistantID,
			finish: 'stop',
		})
		expect(mocks.postMessage).toHaveBeenCalledTimes(3)
		await emitOpenCodeEvent(runner, 'session.inbox.delivered', {
			sessionID: 'session-1',
			inboxID: secondPromptID,
		})
		const secondAssistantID = 'msg_aaaaaaaaaaaa00000000000003'
		await emitOpenCodeEvent(runner, 'session.step.started', {
			sessionID: 'session-1',
			assistantMessageID: secondAssistantID,
		})
		await emitOpenCodeEvent(runner, 'session.text.ended', {
			sessionID: 'session-1',
			assistantMessageID: secondAssistantID,
			ordinal: 0,
			text: 'Second response',
		})
		await emitOpenCodeEvent(runner, 'session.step.ended', {
			sessionID: 'session-1',
			assistantMessageID: secondAssistantID,
			finish: 'stop',
		})
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: 'Second response' }),
		)
		expect(mocks.postMessage).toHaveBeenCalledTimes(4)
		await emitOpenCodeEvent(runner, 'session.execution.succeeded', { sessionID: 'session-1' })
		expect(mocks.postMessage).toHaveBeenCalledTimes(4)
		await runEffect(runner.stop)
	})

	test('starts the next turn after successful V2 execution cleanup', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		await runEffect(runner.handleMention(mention('E1', '2.0', '<@UBOT> first', 'C1', '1.0')))
		await completeTurn(runner, 'session-1')
		histories.set('C1', [
			{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' },
			{ ts: '3.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> next' },
		])
		await runEffect(runner.handleMention(mention('E2', '3.0', '<@UBOT> next', 'C1', '1.0')))
		expect(mocks.promptAsync).toHaveBeenCalledTimes(2)
		expect(mocks.create).toHaveBeenCalledTimes(1)
		await completeTurn(runner, 'session-1')
		await runEffect(runner.stop)
	})

	test('stops publishing assistant chunks when cancellation wins', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		await runEffect(runner.handleMention(mention('E1', '2.0', '<@UBOT> work', 'C1', '1.0')))
		let resolveChunk!: (response: { ok: boolean; ts: string }) => void
		const delayedChunk = new Promise<{ ok: boolean; ts: string }>((resolve) => {
			resolveChunk = resolve
		})
		mocks.postMessage.mockImplementationOnce(() => delayedChunk)
		await emitOpenCodeEvent(runner, 'session.execution.started', { sessionID: 'session-1' })
		const assistantID = 'msg_aaaaaaaaaaaa00000000000004'
		await emitOpenCodeEvent(runner, 'session.step.started', {
			sessionID: 'session-1',
			assistantMessageID: assistantID,
		})
		await emitOpenCodeEvent(runner, 'session.text.ended', {
			sessionID: 'session-1',
			assistantMessageID: assistantID,
			ordinal: 0,
			text: 'x'.repeat(MAX_SLACK_MARKDOWN_CHARS + 100),
		})
		const publishing = emitOpenCodeEvent(runner, 'session.step.ended', {
			sessionID: 'session-1',
			assistantMessageID: assistantID,
			finish: 'stop',
		})
		await vi.waitFor(() => expect(mocks.postMessage).toHaveBeenCalledTimes(2))
		await runEffect(runner.handleMention(mention('E2', '3.0', '<@UBOT> cancel', 'C1', '1.0')))
		resolveChunk({ ok: true, ts: 'assistant-chunk' })
		await publishing
		await emitOpenCodeEvent(runner, 'session.execution.interrupted', { sessionID: 'session-1' })
		expect(mocks.postMessage).toHaveBeenCalledTimes(3)
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: 'Cancelled by <@U1>.' }),
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
		await emitOpenCodeEvent(runner, 'session.created', {
			sessionID: 'ses_child-1',
			parentID: 'session-1',
		})
		expect(await runEffect(runner.shouldDenyPermission('ses_child-1'))).toBe(true)
		await emitOpenCodeEvent(runner, 'session.execution.started', { sessionID: 'session-1' })
		await emitOpenCodeEvent(runner, 'permission.asked', {
			id: 'permission-1',
			sessionID: 'ses_child-1',
		})
		expect(mocks.abort).toHaveBeenCalledWith({ sessionID: 'ses_child-1' })

		await runEffect(runner.handleMention(mention('E2', '2.1', '<@UBOT> cancel', 'C1', '1.0')))
		await emitOpenCodeEvent(runner, 'session.execution.interrupted', { sessionID: 'session-1' })
		await running
		expect(mocks.abort).toHaveBeenCalledWith({ sessionID: 'session-1' })
		expect(mocks.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				markdown_text: expect.stringContaining('Cancelled by <@U1>.'),
			}),
		)
		expect(await runEffect(runner.shouldDenyPermission('ses_child-1'))).toBe(false)
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
		await emitOpenCodeEvent(runner, 'session.execution.interrupted', { sessionID: 'session-1' })
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
		await emitOpenCodeEvent(runner, 'session.execution.started', { sessionID: 'session-1' })
		const status = runEffect(runner.updateStatus('session-1', 'Still working'))
		await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1))
		const cancelling = runEffect(
			runner.handleMention(mention('E2', '2.1', '<@UBOT> cancel', 'C1', '1.0')),
		)
		resolveStatus({ ok: true })
		await Promise.all([status, cancelling])
		await emitOpenCodeEvent(runner, 'session.execution.interrupted', { sessionID: 'session-1' })
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
		let promptSignal: AbortSignal | undefined
		let promptCalls = 0
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' }]],
		])
		const { runner, mocks } = await makeHarness(histories, {
			promptAsync: ({ signal }) => {
				promptCalls += 1
				if (promptCalls > 1) return Promise.resolve()
				promptSignal = signal
				return new Promise((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
				})
			},
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
		await Promise.all([running, queued, cancelling])
		expect(promptSignal?.aborted).toBe(true)
		expect(mocks.promptAsync).toHaveBeenCalledTimes(1)
		expect(mocks.postMessage).toHaveBeenCalledTimes(2)
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: 'Cancelled by <@U1>.' }),
		)
		expect(mocks.abort).toHaveBeenCalledTimes(1)
		expect(mocks.wait).toHaveBeenCalledWith({ sessionID: 'session-1' })
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
		const freshText = mocks.promptAsync.mock.calls[1]?.[0].text
		expect(freshText).not.toContain('more work')
		expect(freshText).not.toContain('must stay cancelled')
		expect(freshText).toContain('fresh request')
		expect(mocks.create).toHaveBeenCalledTimes(1)
		await completeTurn(runner, 'session-1')
		await runEffect(runner.stop)
	})

	test('keeps a cancelled turn active until OpenCode confirms the session is idle', async () => {
		let resolveWait!: () => void
		const wait = new Promise<void>((resolve) => {
			resolveWait = resolve
		})
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' }]],
		])
		const { runner, mocks } = await makeHarness(histories, { wait: () => wait })
		await runEffect(runner.handleMention(mention('E1', '2.0', '<@UBOT> work', 'C1', '1.0')))
		const cancelling = runEffect(
			runner.handleMention(mention('E2', '3.0', '<@UBOT> cancel', 'C1', '1.0')),
		)
		await vi.waitFor(() => expect(mocks.wait).toHaveBeenCalledTimes(1))
		expect(await runEffect(runner.shouldDenyPermission('session-1'))).toBe(true)
		resolveWait()
		await cancelling
		expect(await runEffect(runner.shouldDenyPermission('session-1'))).toBe(false)
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
		await completeTurn(runner, 'session-1')
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
		const promptInput = mocks.promptAsync.mock.calls[0]?.[0]
		expect(promptInput?.files).toHaveLength(0)
		await completeTurn(runner, 'session-1')
		await running
		await runEffect(runner.stop)
	})

	test('ignores intermediate tool-call steps until the terminal response', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		await runEffect(runner.handleMention(mention('E1', '2.0', '<@UBOT> work', 'C1', '1.0')))
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		await emitOpenCodeEvent(runner, 'session.execution.started', { sessionID: 'session-1' })
		const assistantID = 'msg_aaaaaaaaaaaa00000000000005'
		await emitOpenCodeEvent(runner, 'session.step.started', {
			sessionID: 'session-1',
			assistantMessageID: assistantID,
		})
		await emitOpenCodeEvent(runner, 'session.text.ended', {
			sessionID: 'session-1',
			assistantMessageID: assistantID,
			ordinal: 0,
			text: 'Final after tools',
		})
		await emitOpenCodeEvent(runner, 'session.step.ended', {
			sessionID: 'session-1',
			assistantMessageID: assistantID,
			finish: 'tool-calls',
		})
		expect(mocks.postMessage).toHaveBeenCalledTimes(1)
		await emitOpenCodeEvent(runner, 'session.step.ended', {
			sessionID: 'session-1',
			assistantMessageID: assistantID,
			finish: 'stop',
		})
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: 'Final after tools' }),
		)
		await emitOpenCodeEvent(runner, 'session.execution.succeeded', { sessionID: 'session-1' })
		await runEffect(runner.stop)
	})

	test('settles immediately when OpenCode reports a terminal asynchronous error', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		await runEffect(runner.handleMention(mention('E1', '2.0', '<@UBOT> work', 'C1', '1.0')))
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		await emitOpenCodeEvent(runner, 'session.execution.failed', {
			sessionID: 'session-1',
			error: { type: 'UnknownError', message: 'boom' },
		})
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: expect.stringContaining('reported an error') }),
		)
		await runEffect(runner.stop)
	})

	test('does not duplicate a terminal error after an assistant step fails', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		await runEffect(runner.handleMention(mention('E1', '2.0', '<@UBOT> work', 'C1', '1.0')))
		await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledTimes(1))
		await emitOpenCodeEvent(runner, 'session.execution.started', { sessionID: 'session-1' })
		const assistantID = 'msg_aaaaaaaaaaaa00000000000006'
		await emitOpenCodeEvent(runner, 'session.step.started', {
			sessionID: 'session-1',
			assistantMessageID: assistantID,
		})
		await emitOpenCodeEvent(runner, 'session.step.failed', {
			sessionID: 'session-1',
			assistantMessageID: assistantID,
			finish: 'error',
		})
		expect(mocks.postMessage).toHaveBeenCalledTimes(2)
		await emitOpenCodeEvent(runner, 'session.execution.failed', {
			sessionID: 'session-1',
			error: { type: 'ContextOverflowError', message: 'too much context' },
		})
		expect(mocks.postMessage).toHaveBeenCalledTimes(2)
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
		await emitOpenCodeEvent(runner, 'session.deleted', { sessionID: 'session-1' })
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
		await completeTurn(runner, 'session-2')
		await second
		await runEffect(runner.stop)
	})
})
