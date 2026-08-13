import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Effect } from 'effect'
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
const VALID_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
	'base64',
)

type TestPromptPart =
	| { type: 'text'; text: string; mime?: undefined; filename?: undefined; url?: undefined }
	| { type: 'file'; text?: undefined; mime: string; filename: string; url: string }

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
		assistantID?: string | ((input: { call: number; sessionID: string }) => string)
		assistantParentID?:
			| string
			| ((input: { call: number; latestPromptID: string | undefined; sessionID: string }) => string)
		assistantText?: string
		fetch?: typeof globalThis.fetch
		filesUploadV2?: (args: Record<string, unknown>) => Promise<unknown>
		getUploadURLExternal?: (args: Record<string, unknown>) => Promise<unknown>
		completeUploadExternal?: (args: Record<string, unknown>) => Promise<unknown>
		fileInfo?: (args: { file: string }) => Promise<unknown>
		create?: (args: { signal?: AbortSignal }) => Promise<{ data: { id: string } }>
		promptAsync?: (args: {
			path: { id: string }
			body: {
				agent: string
				messageID: string
				tools: Record<string, boolean>
				parts: Array<TestPromptPart>
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
				parts: Array<TestPromptPart>
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
		const configuredID =
			typeof behavior.assistantID === 'function'
				? behavior.assistantID({ call: messages.mock.calls.length, sessionID: args.path.id })
				: behavior.assistantID
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
						id: configuredID ?? 'msg_ffffffffffffffffffffffffff',
						role: 'assistant',
						parentID: configuredParent ?? parentID,
						finish: 'stop',
						time: { created: Date.now() + 1_000, completed: Date.now() + 2_000 },
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
			await runEffect(
				runner.handleOpenCodeEvent({
					type: 'session.idle',
					properties: { sessionID: 'session-1' },
				}),
			)
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
			await runEffect(
				runner.handleOpenCodeEvent({
					type: 'session.idle',
					properties: { sessionID: 'session-1' },
				}),
			)
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
			await runEffect(
				runner.handleOpenCodeEvent({
					type: 'session.idle',
					properties: { sessionID: 'session-1' },
				}),
			)
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
			await runEffect(
				runner.handleOpenCodeEvent({
					type: 'session.idle',
					properties: { sessionID: 'session-1' },
				}),
			)
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
		expect(promptBody.tools).toEqual({
			question: false,
			slack_attach_file: true,
			slack_status: true,
		})
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
		const parts = mocks.promptAsync.mock.calls[0]?.[0].body.parts
		if (parts === undefined) throw new Error('missing OpenCode prompt parts')
		expect(parts.map((part) => part.type)).toEqual(['text', 'file', 'text', 'file'])
		const files = parts.filter((part) => part.type === 'file')
		expect(files[0]).toMatchObject({ filename: 'design.md', mime: 'text/plain' })
		expect(files[0]?.url).toBe(`data:text/plain;base64,${markdown.toString('base64')}`)
		expect(files[1]).toMatchObject({ filename: 'requirements.pdf', mime: 'application/pdf' })
		expect(files[1]?.url).toBe(`data:application/pdf;base64,${pdf.toString('base64')}`)
		expect(parts[0]?.text).toContain('Slack file attached: design.md (text/plain)')
		expect(parts[2]?.text).toContain('Slack file attached: requirements.pdf (application/pdf)')
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
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
		expect(mocks.promptAsync.mock.calls[0]?.[0].body.parts).toContainEqual(
			expect.objectContaining({ type: 'file', mime: 'text/plain', filename: 'notes.md' }),
		)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
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
		const files = mocks.promptAsync.mock.calls[0]?.[0].body.parts.filter(
			(part) => part.type === 'file',
		)
		expect(files?.map((file) => file.filename)).toEqual(['old-one.md', 'trigger.md'])
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
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
		const files = mocks.promptAsync.mock.calls[0]?.[0].body.parts.filter(
			(part) => part.type === 'file',
		)
		expect(files?.map((file) => file.filename)).toEqual(['valid.png'])
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
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
		const parts = mocks.promptAsync.mock.calls[0]?.[0].body.parts
		if (parts === undefined) throw new Error('missing OpenCode prompt parts')
		expect(parts.filter((part) => part.type === 'file')).toHaveLength(0)
		expect(parts[0]?.text).toContain(
			'Attachment omitted: Slack file invalid.md could not be imported',
		)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
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
		const parts = mocks.promptAsync.mock.calls[0]?.[0].body.parts
		if (parts === undefined) throw new Error('missing OpenCode prompt parts')
		expect(parts.filter((part) => part.type === 'file')).toHaveLength(0)
		expect(parts[0]?.text).toContain(
			'Attachment omitted: Slack file truncated.png could not be imported',
		)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
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
		const parts = mocks.promptAsync.mock.calls[0]?.[0].body.parts
		if (parts === undefined) throw new Error('missing OpenCode prompt parts')
		expect(parts.filter((part) => part.type === 'file')).toHaveLength(2)
		expect(parts[0]?.text).toContain(
			'Slack attachment three.md beyond the per-turn attachment limits',
		)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
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
			assistantID: ({ call }) => `msg_ffffffffffff${call.toString().padStart(14, '0')}`,
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
		expect(mocks.postMessage).toHaveBeenCalledTimes(3)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: '**Final answer**' }),
		)
		expect(mocks.postMessage).toHaveBeenCalledTimes(4)
		await runEffect(runner.stop)
	})

	test('delivers the response before a steering response without waiting for session idle', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		await runEffect(runner.handleMention(mention('E1', '2.0', '<@UBOT> first', 'C1', '1.0')))
		const firstPromptID = mocks.promptAsync.mock.calls[0]?.[0].body.messageID
		if (firstPromptID === undefined) throw new Error('missing first prompt ID')
		histories.set('C1', [
			{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> first' },
			{ ts: '3.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> follow up' },
		])
		await runEffect(runner.handleMention(mention('E2', '3.0', '<@UBOT> follow up', 'C1', '1.0')))
		const secondPromptID = mocks.promptAsync.mock.calls[1]?.[0].body.messageID
		if (secondPromptID === undefined) throw new Error('missing second prompt ID')
		const firstAssistant = {
			info: {
				finish: 'stop',
				id: 'msg_ffffffffffff00000000000001',
				parentID: firstPromptID,
				role: 'assistant',
				time: { completed: 2, created: 1 },
			},
			parts: [{ ignored: false, text: 'First response', type: 'text' }],
		}
		const secondAssistant = {
			info: {
				finish: 'stop',
				id: 'msg_ffffffffffff00000000000002',
				parentID: secondPromptID,
				role: 'assistant',
				time: { completed: 4, created: 3 },
			},
			parts: [{ ignored: false, text: 'Second response', type: 'text' }],
		}
		mocks.messages.mockImplementation(() => Promise.resolve({ data: [firstAssistant] }))
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'message.updated',
				properties: {
					info: {
						finish: 'stop',
						id: firstAssistant.info.id,
						parentID: firstPromptID,
						role: 'assistant',
						sessionID: 'session-1',
						time: { completed: 2 },
					},
				},
			}),
		)
		expect(mocks.messages).toHaveBeenCalledTimes(1)
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: 'First response' }),
		)
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'message.updated',
				properties: {
					info: {
						finish: 'stop',
						id: firstAssistant.info.id,
						parentID: firstPromptID,
						role: 'assistant',
						sessionID: 'session-1',
						time: { completed: 2 },
					},
				},
			}),
		)
		expect(mocks.postMessage).toHaveBeenCalledTimes(3)

		mocks.messages.mockImplementation(() =>
			Promise.resolve({ data: [firstAssistant, secondAssistant] }),
		)
		await runEffect(
			runner.handleOpenCodeEvent({
				type: 'message.updated',
				properties: {
					info: {
						finish: 'stop',
						id: secondAssistant.info.id,
						parentID: secondPromptID,
						role: 'assistant',
						sessionID: 'session-1',
						time: { completed: 4 },
					},
				},
			}),
		)
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: 'Second response' }),
		)
		expect(mocks.postMessage).toHaveBeenCalledTimes(4)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		expect(mocks.postMessage).toHaveBeenCalledTimes(4)
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

	test('does not publish a completed response after cancellation wins reconciliation', async () => {
		const histories = new Map<string, Array<SlackMessage>>([
			['C1', [{ ts: '2.0', thread_ts: '1.0', user: 'U1', text: '<@UBOT> work' }]],
		])
		const { runner, mocks } = await makeHarness(histories)
		await runEffect(runner.handleMention(mention('E1', '2.0', '<@UBOT> work', 'C1', '1.0')))
		const promptID = mocks.promptAsync.mock.calls[0]?.[0].body.messageID
		if (promptID === undefined) throw new Error('missing prompt ID')
		let resolveMessages!: (response: ReturnType<typeof completedMessagesResponse>) => void
		function completedMessagesResponse() {
			return {
				data: [
					{
						info: {
							finish: 'stop',
							id: 'msg_ffffffffffff00000000000001',
							parentID: promptID,
							role: 'assistant',
							time: { completed: 2, created: 1 },
						},
						parts: [{ ignored: false, text: 'Should not be posted', type: 'text' }],
					},
				],
			}
		}
		const delayedMessages = new Promise<ReturnType<typeof completedMessagesResponse>>((resolve) => {
			resolveMessages = resolve
		})
		mocks.messages.mockImplementationOnce(() => delayedMessages)
		const reconciling = runEffect(
			runner.handleOpenCodeEvent({
				type: 'message.updated',
				properties: {
					info: {
						finish: 'stop',
						id: 'msg_ffffffffffff00000000000001',
						parentID: promptID,
						role: 'assistant',
						sessionID: 'session-1',
						time: { completed: 2 },
					},
				},
			}),
		)
		await vi.waitFor(() => expect(mocks.messages).toHaveBeenCalledTimes(1))
		await runEffect(runner.handleMention(mention('E2', '3.0', '<@UBOT> cancel', 'C1', '1.0')))
		resolveMessages(completedMessagesResponse())
		await reconciling
		expect(mocks.postMessage).toHaveBeenCalledTimes(2)
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: 'Cancelled by <@U1>.' }),
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
				info: {
					finish: string
					id: string
					parentID: string | undefined
					role: string
					time: { completed: number; created: number }
				}
				parts: Array<{ ignored: boolean; text: string; type: string }>
			}>
		}) => void
		const delayedMessages = new Promise<{
			data: Array<{
				info: {
					finish: string
					id: string
					parentID: string | undefined
					role: string
					time: { completed: number; created: number }
				}
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
						finish: 'stop',
						id: 'msg_ffffffffffffffffffffffffff',
						parentID,
						role: 'assistant',
						time: { completed: Date.now(), created: Date.now() },
					},
					parts: [{ ignored: false, text: '**Final answer**', type: 'text' }],
				},
			],
		})
		await staleIdle
		expect(mocks.postMessage).toHaveBeenCalledTimes(3)
		await runEffect(
			runner.handleOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
		)
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ markdown_text: '**Final answer**' }),
		)
		expect(mocks.postMessage).toHaveBeenCalledTimes(3)
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
