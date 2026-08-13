import { Effect, Option, Schema } from 'effect'
import { describeUnknown } from '../../lib/guards'
import {
	MAX_SLACK_ATTACHMENTS_PER_TURN,
	MAX_SLACK_FILE_INFO_REQUESTS_PER_TURN,
	MAX_SLACK_MARKDOWN_CHARS,
	MAX_SLACK_MEDIA_BYTES,
	MAX_SLACK_TEXT_BYTES_PER_TURN,
	MAX_SLACK_TEXT_FILE_BYTES,
} from './config'
import { type SlackIntegrationError, slackIntegrationError } from './errors'
import { validateSlackImage } from './image'
import type { SlackAppHandle, SlackRunnerOptions } from './runtime'
import {
	type SlackAttachmentMime,
	type SlackFile,
	SlackFileInfoResponse,
	SlackImageMime,
	type SlackImageMime as SlackImageMimeType,
	type SlackMessage,
	type SlackPromptPart,
	SlackRepliesResponse,
} from './schema'

function compareTimestampText(left: string, right: string): number {
	const timestamp = /^(\d+)(?:\.(\d+))?$/u
	const leftMatch = timestamp.exec(left)
	const rightMatch = timestamp.exec(right)
	if (leftMatch === null || rightMatch === null) return left.localeCompare(right)
	const leftSeconds = BigInt(leftMatch[1] as string)
	const rightSeconds = BigInt(rightMatch[1] as string)
	if (leftSeconds !== rightSeconds) return leftSeconds < rightSeconds ? -1 : 1
	const leftFraction = leftMatch[2] ?? ''
	const rightFraction = rightMatch[2] ?? ''
	const width = Math.max(leftFraction.length, rightFraction.length)
	return leftFraction.padEnd(width, '0').localeCompare(rightFraction.padEnd(width, '0'))
}

export function compareSlackMessages(left: SlackMessage, right: SlackMessage): number {
	return compareTimestampText(left.ts, right.ts)
}

export function isAfterSlackTimestamp(candidate: string, previous: string | undefined): boolean {
	return previous === undefined || compareTimestampText(candidate, previous) > 0
}

function slackApiError(operation: string, error: unknown): SlackIntegrationError {
	return slackIntegrationError(
		operation,
		`${operation} failed: ${describeUnknown(error).slice(0, 500)}`,
	)
}

export const fetchSlackThread = Effect.fn('fetchSlackThread')(function* (
	app: SlackAppHandle,
	channel: string,
	threadTs: string,
	latest: string,
	oldest: string | undefined,
) {
	const messages: Array<SlackMessage> = []
	let cursor: string | undefined
	do {
		const response = yield* Effect.tryPromise({
			try: () =>
				app.client.conversations.replies({
					channel,
					ts: threadTs,
					latest,
					inclusive: true,
					limit: 200,
					...(oldest === undefined ? {} : { oldest }),
					...(cursor === undefined ? {} : { cursor }),
				}),
			catch: (error) => slackApiError('Slack thread history request', error),
		})
		const decoded = yield* Schema.decodeUnknownEffect(SlackRepliesResponse)(response).pipe(
			Effect.mapError((error) =>
				slackIntegrationError(
					'Slack thread history response',
					`Slack returned malformed thread history: ${error.message.slice(0, 500)}`,
				),
			),
		)
		messages.push(...(decoded.messages ?? []))
		const next = decoded.response_metadata?.next_cursor?.trim()
		cursor = next === undefined || next.length === 0 ? undefined : next
	} while (cursor !== undefined)
	return messages.sort(compareSlackMessages)
})

function imageMime(file: SlackFile): Option.Option<SlackImageMimeType> {
	return Schema.decodeUnknownOption(SlackImageMime)(file.mimetype)
}

const TEXT_FILE_EXTENSIONS = new Set([
	'c',
	'cc',
	'conf',
	'cpp',
	'cs',
	'css',
	'csv',
	'diff',
	'go',
	'h',
	'hpp',
	'html',
	'ini',
	'java',
	'js',
	'json',
	'jsonl',
	'jsx',
	'kt',
	'log',
	'lua',
	'm',
	'markdown',
	'md',
	'mjs',
	'patch',
	'php',
	'pl',
	'properties',
	'py',
	'r',
	'rb',
	'rs',
	'scala',
	'sh',
	'sql',
	'swift',
	'toml',
	'ts',
	'tsv',
	'tsx',
	'txt',
	'xml',
	'yaml',
	'yml',
	'zsh',
])

const TEXT_SLACK_FILETYPES = new Set([
	'c',
	'csharp',
	'css',
	'csv',
	'diff',
	'go',
	'html',
	'java',
	'javascript',
	'json',
	'kotlin',
	'markdown',
	'php',
	'plaintext',
	'python',
	'ruby',
	'rust',
	'shell',
	'sql',
	'swift',
	'text',
	'toml',
	'tsv',
	'typescript',
	'xml',
	'yaml',
])

function normalizedMime(file: SlackFile): string {
	return file.mimetype?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function fileExtension(file: SlackFile): string {
	const name = file.name ?? file.title ?? ''
	const separator = name.lastIndexOf('.')
	return separator < 0
		? ''
		: name
				.slice(separator + 1)
				.trim()
				.toLowerCase()
}

function textMetadata(file: SlackFile): boolean {
	const mime = normalizedMime(file)
	return (
		mime.startsWith('text/') ||
		mime === 'application/json' ||
		mime === 'application/ld+json' ||
		mime === 'application/toml' ||
		mime === 'application/xml' ||
		mime === 'application/yaml' ||
		mime === 'application/x-yaml' ||
		mime.endsWith('+json') ||
		mime.endsWith('+xml') ||
		TEXT_SLACK_FILETYPES.has(file.filetype?.trim().toLowerCase() ?? '') ||
		TEXT_FILE_EXTENSIONS.has(fileExtension(file))
	)
}

function attachmentKind(file: SlackFile): 'image' | 'pdf' | 'text' | undefined {
	if (Option.isSome(imageMime(file))) return 'image'
	if (normalizedMime(file) === 'application/pdf' || file.filetype === 'pdf') return 'pdf'
	if (textMetadata(file)) return 'text'
	return undefined
}

function privateSlackFileUrl(value: string | undefined): Option.Option<string> {
	if (value === undefined) return Option.none()
	try {
		const url = new URL(value)
		return url.protocol === 'https:' &&
			(url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'))
			? Option.some(url.toString())
			: Option.none()
	} catch {
		return Option.none()
	}
}

function attachmentUrl(file: SlackFile): Option.Option<string> {
	return privateSlackFileUrl(file.url_private_download).pipe(
		Option.orElse(() => privateSlackFileUrl(file.url_private)),
	)
}

function metadataWithinLimit(file: SlackFile): boolean {
	const kind = attachmentKind(file)
	if (kind === undefined) return file.file_access === 'check_file_info'
	if (Option.isNone(attachmentUrl(file)) && file.file_access !== 'check_file_info') return false
	const maximum = kind === 'text' ? MAX_SLACK_TEXT_FILE_BYTES : MAX_SLACK_MEDIA_BYTES
	return file.size === undefined || file.size <= maximum
}

export function selectSlackAttachmentIDs(
	messages: ReadonlyArray<SlackMessage>,
	triggerTs: string,
): ReadonlySet<string> {
	const trigger = messages.filter((message) => message.ts === triggerTs)
	const context = messages.filter((message) => message.ts !== triggerTs)
	const selected = new Set<string>()
	let selectedTextBytes = 0
	for (const message of [...trigger, ...context]) {
		for (const file of message.files ?? []) {
			if (selected.size >= MAX_SLACK_ATTACHMENTS_PER_TURN) return selected
			if (selected.has(file.id) || !metadataWithinLimit(file)) continue
			if (attachmentKind(file) === 'text') {
				const reservation = file.size ?? MAX_SLACK_TEXT_FILE_BYTES
				if (selectedTextBytes + reservation > MAX_SLACK_TEXT_BYTES_PER_TURN) continue
				selectedTextBytes += reservation
			}
			selected.add(file.id)
		}
	}
	return selected
}

export const selectSlackImageIDs = selectSlackAttachmentIDs

function fileName(file: SlackFile): string {
	const candidate = file.name?.trim() || file.title?.trim() || file.id
	const sanitized = Array.from(candidate, (character) => {
		const code = character.codePointAt(0) ?? 0
		return code <= 0x1f || code === 0x7f || character === '/' || character === '\\'
			? '_'
			: character
	})
		.join('')
		.slice(0, 200)
	return sanitized.length === 0 ? file.id : sanitized
}

function omissionReason(
	file: SlackFile,
	selected: ReadonlySet<string>,
	consumed: ReadonlySet<string>,
): string | undefined {
	const kind = attachmentKind(file)
	if (kind === undefined && file.file_access !== 'check_file_info')
		return `unsupported attachment ${fileName(file)} (${file.mimetype ?? 'unknown MIME type'})`
	if (Option.isNone(attachmentUrl(file)) && file.file_access !== 'check_file_info')
		return `unavailable or untrusted Slack attachment ${fileName(file)}`
	const maximum = kind === 'text' ? MAX_SLACK_TEXT_FILE_BYTES : MAX_SLACK_MEDIA_BYTES
	if (file.size !== undefined && file.size > maximum)
		return `oversized Slack attachment ${fileName(file)} (${file.size} bytes)`
	if (!selected.has(file.id))
		return `Slack attachment ${fileName(file)} beyond the per-turn attachment limits`
	if (consumed.has(file.id)) return `duplicate Slack attachment ${fileName(file)}`
	return undefined
}

const readBoundedResponse = Effect.fn('readBoundedResponse')(function* (
	response: Response,
	signal: AbortSignal,
	maximumBytes: number,
) {
	const reader = response.body?.getReader()
	if (reader === undefined) {
		const bytes = new Uint8Array(
			yield* Effect.tryPromise({
				try: () => response.arrayBuffer(),
				catch: (error) => slackApiError('Slack attachment download', error),
			}),
		)
		if (bytes.byteLength > maximumBytes)
			return yield* slackIntegrationError(
				'Slack attachment download',
				'Slack attachment exceeds the size limit',
			)
		return bytes
	}
	const chunks: Array<Uint8Array> = []
	let total = 0
	yield* Effect.acquireUseRelease(
		Effect.succeed(reader),
		(stream) =>
			Effect.gen(function* () {
				while (true) {
					yield* Effect.try({
						try: () => signal.throwIfAborted(),
						catch: (error) => slackApiError('Slack attachment download', error),
					})
					const next = yield* Effect.tryPromise({
						try: () => stream.read(),
						catch: (error) => slackApiError('Slack attachment download', error),
					})
					if (next.done) break
					total += next.value.byteLength
					if (total > maximumBytes) {
						yield* Effect.tryPromise({
							try: () => stream.cancel('attachment exceeds the size limit'),
							catch: () => undefined,
						}).pipe(Effect.ignore)
						return yield* slackIntegrationError(
							'Slack attachment download',
							'Slack attachment exceeds the size limit',
						)
					}
					chunks.push(next.value)
				}
			}),
		(stream) => Effect.sync(() => stream.releaseLock()),
	)
	const bytes = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return bytes
})

const resolveSlackFile = Effect.fn('resolveSlackFile')(function* (
	app: SlackAppHandle,
	file: SlackFile,
) {
	if (attachmentKind(file) !== undefined && Option.isSome(attachmentUrl(file))) return file
	const response = yield* Effect.tryPromise({
		try: () => app.client.files.info({ file: file.id }),
		catch: (error) => slackApiError('Slack file metadata request', error),
	})
	const decoded = yield* Schema.decodeUnknownEffect(SlackFileInfoResponse)(response).pipe(
		Effect.mapError((error) =>
			slackIntegrationError(
				'Slack file metadata response',
				`Slack returned malformed file metadata: ${error.message.slice(0, 500)}`,
			),
		),
	)
	if (decoded.file === undefined)
		return yield* slackIntegrationError(
			'Slack file metadata response',
			'Slack did not return file metadata',
		)
	return {
		...file,
		...decoded.file,
		file_access: decoded.file.file_access ?? 'available',
	}
})

export const resolveSlackFiles = Effect.fn('resolveSlackFiles')(function* (
	messages: ReadonlyArray<SlackMessage>,
	triggerTs: string,
	app: SlackAppHandle,
) {
	const trigger = messages.filter((message) => message.ts === triggerTs)
	const context = messages.filter((message) => message.ts !== triggerTs)
	const resolved = new Map<string, SlackFile>()
	let metadataRequests = 0
	for (const message of [...trigger, ...context]) {
		for (const file of message.files ?? []) {
			if (resolved.has(file.id)) continue
			const needsResolution =
				file.file_access === 'check_file_info' ||
				(attachmentKind(file) !== undefined && Option.isNone(attachmentUrl(file)))
			if (!needsResolution) {
				resolved.set(file.id, file)
				continue
			}
			if (metadataRequests >= MAX_SLACK_FILE_INFO_REQUESTS_PER_TURN) {
				resolved.set(file.id, { ...file, file_access: 'metadata_unavailable' })
				continue
			}
			metadataRequests += 1
			const result = yield* resolveSlackFile(app, file).pipe(Effect.option)
			resolved.set(
				file.id,
				Option.getOrElse(result, () => ({ ...file, file_access: 'metadata_unavailable' })),
			)
		}
	}
	return messages.map((message) => ({
		...message,
		...(message.files === undefined
			? {}
			: { files: message.files.map((file) => resolved.get(file.id) ?? file) }),
	}))
})

function startsWithBytes(bytes: Uint8Array, expected: ReadonlyArray<number>): boolean {
	return expected.every((value, index) => bytes[index] === value)
}

function validTextBytes(bytes: Uint8Array): boolean {
	try {
		return !new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0')
	} catch {
		return false
	}
}

const downloadSlackAttachment = Effect.fn('downloadSlackAttachment')(function* (
	file: SlackFile,
	botToken: string,
	options: SlackRunnerOptions,
	signal: AbortSignal,
	consumedTextBytes: Map<string, number>,
) {
	const kind = attachmentKind(file)
	const mime = Schema.decodeUnknownOption(SlackImageMime)(file.mimetype)
	const privateUrl = attachmentUrl(file)
	if (kind === undefined || Option.isNone(privateUrl))
		return yield* slackIntegrationError(
			'Slack attachment download',
			'Slack attachment metadata is incomplete or unsupported',
		)
	const maximumBytes = kind === 'text' ? MAX_SLACK_TEXT_FILE_BYTES : MAX_SLACK_MEDIA_BYTES
	const response = yield* Effect.tryPromise({
		try: () =>
			options.fetch(privateUrl.value, {
				headers: { Authorization: `Bearer ${botToken}` },
				redirect: 'follow',
				signal,
			}),
		catch: (error) => slackApiError('Slack attachment download', error),
	})
	if (!response.ok)
		return yield* slackIntegrationError(
			'Slack attachment download',
			`Slack attachment download returned HTTP ${response.status}`,
		)
	const contentLength = Number(response.headers.get('content-length'))
	if (Number.isFinite(contentLength) && contentLength > maximumBytes)
		return yield* slackIntegrationError(
			'Slack attachment download',
			'Slack attachment exceeds the size limit',
		)
	const bytes = yield* readBoundedResponse(response, signal, maximumBytes)
	const validImage =
		kind !== 'image' ||
		(Option.isSome(mime) && (yield* validateSlackImage(bytes, mime.value, signal)))
	if (!validImage)
		return yield* slackIntegrationError(
			'Slack attachment download',
			'Slack image contents do not match its declared type',
		)
	if (kind === 'pdf' && !startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]))
		return yield* slackIntegrationError(
			'Slack attachment download',
			'Slack PDF contents are invalid',
		)
	if (kind === 'text') {
		if (!validTextBytes(bytes))
			return yield* slackIntegrationError(
				'Slack attachment download',
				'Slack text attachment is not valid UTF-8 text',
			)
		const aggregate = [...consumedTextBytes.values()].reduce((total, size) => total + size, 0)
		if (aggregate + bytes.byteLength > MAX_SLACK_TEXT_BYTES_PER_TURN)
			return yield* slackIntegrationError(
				'Slack attachment download',
				'Slack text attachments exceed the aggregate size limit',
			)
		consumedTextBytes.set(file.id, bytes.byteLength)
	}
	const outputMime: SlackAttachmentMime =
		kind === 'image' && Option.isSome(mime)
			? mime.value
			: kind === 'pdf'
				? 'application/pdf'
				: 'text/plain'
	return {
		type: 'file' as const,
		mime: outputMime,
		filename: fileName(file),
		url: `data:${outputMime};base64,${Buffer.from(bytes).toString('base64')}`,
	}
})

function authorLabel(message: SlackMessage, botUserID: string): string {
	if (message.user === botUserID) return 'this Slack bot (quoted prior response)'
	if (message.user !== undefined) return `<@${message.user}>`
	if (message.bot_id !== undefined) return `Slack bot ${message.bot_id}`
	return 'unknown Slack author'
}

export const prepareSlackMessageParts = Effect.fn('prepareSlackMessageParts')(function* (
	message: SlackMessage,
	selectedAttachments: ReadonlySet<string>,
	consumedAttachments: Set<string>,
	consumedTextBytes: Map<string, number>,
	app: SlackAppHandle,
	botUserID: string,
	botToken: string,
	options: SlackRunnerOptions,
	signal: AbortSignal,
	textOverride?: string,
) {
	const notes: Array<string> = []
	const attachments: Array<SlackPromptPart> = []
	for (const file of message.files ?? []) {
		const omitted = omissionReason(file, selectedAttachments, consumedAttachments)
		if (omitted !== undefined) {
			notes.push(`[Attachment omitted: ${omitted}.]`)
			continue
		}
		consumedAttachments.add(file.id)
		const result = yield* resolveSlackFile(app, file).pipe(
			Effect.flatMap((resolved) =>
				downloadSlackAttachment(resolved, botToken, options, signal, consumedTextBytes).pipe(
					Effect.map((value) => ({ resolved, value })),
				),
			),
			Effect.match({
				onFailure: (error) => ({ ok: false as const, error }),
				onSuccess: (value) => ({ ok: true as const, value }),
			}),
		)
		if (!result.ok) {
			notes.push(`[Attachment omitted: Slack file ${fileName(file)} could not be imported.]`)
			yield* Effect.logWarning(
				`[limitless] Slack attachment ${file.id} was omitted: ${result.error.message}`,
			)
			continue
		}
		const alt = result.value.resolved.alt_txt?.trim()
		const kind = attachmentKind(result.value.resolved)
		notes.push(
			kind === 'image'
				? `[Slack image attached: ${fileName(result.value.resolved)}${alt === undefined || alt.length === 0 ? '' : `; alt text: ${alt}`}].`
				: `[Slack file attached: ${fileName(result.value.resolved)} (${result.value.value.mime})].`,
		)
		attachments.push(result.value.value)
	}
	const body = textOverride ?? message.text ?? ''
	const text = [
		`[Slack message from ${authorLabel(message, botUserID)} at ${message.ts}]`,
		body.trim().length === 0 ? '(no message text)' : body.trim(),
		...notes,
	].join('\n')
	return [{ type: 'text' as const, text }, ...attachments] satisfies ReadonlyArray<SlackPromptPart>
})

export function chunkSlackMarkdown(
	text: string,
	firstChunkChars = MAX_SLACK_MARKDOWN_CHARS,
): ReadonlyArray<string> {
	const normalized =
		text.trim().length === 0 ? 'Completed without a textual response.' : text.trim()
	const chunks: Array<string> = []
	let remaining = normalized
	while (remaining.length > 0) {
		const limit =
			chunks.length === 0
				? Math.max(1, Math.min(firstChunkChars, MAX_SLACK_MARKDOWN_CHARS))
				: MAX_SLACK_MARKDOWN_CHARS
		if (remaining.length <= limit) {
			chunks.push(remaining)
			break
		}
		const window = remaining.slice(0, limit)
		const newline = window.lastIndexOf('\n')
		const split = newline >= limit / 2 ? newline : limit
		chunks.push(remaining.slice(0, split).trimEnd())
		remaining = remaining.slice(split).trimStart()
	}
	return chunks
}
