import { Effect, Option, Schema } from 'effect'
import { describeUnknown } from '../../lib/guards'
import {
	MAX_SLACK_IMAGE_BYTES,
	MAX_SLACK_IMAGES_PER_TURN,
	MAX_SLACK_MARKDOWN_CHARS,
} from './config'
import { type SlackIntegrationError, slackIntegrationError } from './errors'
import type { SlackAppHandle, SlackRunnerOptions } from './runtime'
import {
	type SlackFile,
	SlackImageMime,
	type SlackImageMime as SlackImageMimeType,
	type SlackMessage,
	type SlackPromptPart,
	SlackRepliesResponse,
} from './schema'

function messageTime(value: string): number {
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

export function compareSlackMessages(left: SlackMessage, right: SlackMessage): number {
	return messageTime(left.ts) - messageTime(right.ts)
}

export function isAfterSlackTimestamp(candidate: string, previous: string | undefined): boolean {
	return previous === undefined || messageTime(candidate) > messageTime(previous)
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

function eligibleImage(file: SlackFile): boolean {
	return (
		Option.isSome(imageMime(file)) &&
		Option.isSome(privateSlackFileUrl(file.url_private)) &&
		(file.size === undefined || file.size <= MAX_SLACK_IMAGE_BYTES)
	)
}

export function selectSlackImageIDs(
	messages: ReadonlyArray<SlackMessage>,
	triggerTs: string,
): ReadonlySet<string> {
	const trigger = messages.filter((message) => message.ts === triggerTs)
	const context = messages.filter((message) => message.ts !== triggerTs)
	const selected = new Set<string>()
	for (const message of [...trigger, ...context]) {
		for (const file of message.files ?? []) {
			if (selected.size >= MAX_SLACK_IMAGES_PER_TURN) return selected
			if (!selected.has(file.id) && eligibleImage(file)) selected.add(file.id)
		}
	}
	return selected
}

function fileName(file: SlackFile): string {
	return file.name?.trim() || file.title?.trim() || file.id
}

function omissionReason(
	file: SlackFile,
	selected: ReadonlySet<string>,
	consumed: ReadonlySet<string>,
): string | undefined {
	if (Option.isNone(imageMime(file)))
		return `unsupported attachment ${fileName(file)} (${file.mimetype ?? 'unknown MIME type'})`
	if (Option.isNone(privateSlackFileUrl(file.url_private)))
		return `unavailable or untrusted Slack image ${fileName(file)}`
	if (file.size !== undefined && file.size > MAX_SLACK_IMAGE_BYTES)
		return `oversized Slack image ${fileName(file)} (${file.size} bytes)`
	if (!selected.has(file.id)) return `Slack image ${fileName(file)} beyond the per-turn image limit`
	if (consumed.has(file.id)) return `duplicate Slack image ${fileName(file)}`
	return undefined
}

const readBoundedResponse = Effect.fn('readBoundedResponse')(function* (
	response: Response,
	signal: AbortSignal,
) {
	const reader = response.body?.getReader()
	if (reader === undefined) {
		const bytes = new Uint8Array(
			yield* Effect.tryPromise({
				try: () => response.arrayBuffer(),
				catch: (error) => slackApiError('Slack image download', error),
			}),
		)
		if (bytes.byteLength > MAX_SLACK_IMAGE_BYTES)
			return yield* slackIntegrationError(
				'Slack image download',
				'Slack image exceeds the size limit',
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
						catch: (error) => slackApiError('Slack image download', error),
					})
					const next = yield* Effect.tryPromise({
						try: () => stream.read(),
						catch: (error) => slackApiError('Slack image download', error),
					})
					if (next.done) break
					total += next.value.byteLength
					if (total > MAX_SLACK_IMAGE_BYTES) {
						yield* Effect.tryPromise({
							try: () => stream.cancel('image exceeds the size limit'),
							catch: () => undefined,
						}).pipe(Effect.ignore)
						return yield* slackIntegrationError(
							'Slack image download',
							'Slack image exceeds the size limit',
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

const downloadSlackImage = Effect.fn('downloadSlackImage')(function* (
	file: SlackFile,
	botToken: string,
	options: SlackRunnerOptions,
	signal: AbortSignal,
) {
	const mime = Schema.decodeUnknownOption(SlackImageMime)(file.mimetype)
	const privateUrl = privateSlackFileUrl(file.url_private)
	if (Option.isNone(mime) || Option.isNone(privateUrl))
		return yield* slackIntegrationError(
			'Slack image download',
			'Slack image metadata is incomplete',
		)
	const response = yield* Effect.tryPromise({
		try: () =>
			options.fetch(privateUrl.value, {
				headers: { Authorization: `Bearer ${botToken}` },
				redirect: 'follow',
				signal,
			}),
		catch: (error) => slackApiError('Slack image download', error),
	})
	if (!response.ok)
		return yield* slackIntegrationError(
			'Slack image download',
			`Slack image download returned HTTP ${response.status}`,
		)
	const contentLength = Number(response.headers.get('content-length'))
	if (Number.isFinite(contentLength) && contentLength > MAX_SLACK_IMAGE_BYTES)
		return yield* slackIntegrationError(
			'Slack image download',
			'Slack image exceeds the size limit',
		)
	const bytes = yield* readBoundedResponse(response, signal)
	return {
		type: 'file' as const,
		mime: mime.value,
		filename: fileName(file),
		url: `data:${mime.value};base64,${Buffer.from(bytes).toString('base64')}`,
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
	selectedImages: ReadonlySet<string>,
	consumedImages: Set<string>,
	botUserID: string,
	botToken: string,
	options: SlackRunnerOptions,
	signal: AbortSignal,
	textOverride?: string,
) {
	const notes: Array<string> = []
	const images: Array<SlackPromptPart> = []
	for (const file of message.files ?? []) {
		const omitted = omissionReason(file, selectedImages, consumedImages)
		if (omitted !== undefined) {
			notes.push(`[Attachment omitted: ${omitted}.]`)
			continue
		}
		consumedImages.add(file.id)
		const result = yield* downloadSlackImage(file, botToken, options, signal).pipe(
			Effect.match({
				onFailure: (error) => ({ ok: false as const, error }),
				onSuccess: (value) => ({ ok: true as const, value }),
			}),
		)
		if (!result.ok) {
			notes.push(`[Attachment omitted: Slack image ${fileName(file)} could not be downloaded.]`)
			yield* Effect.logWarning(
				`[limitless] Slack image ${file.id} was omitted: ${result.error.message}`,
			)
			continue
		}
		const alt = file.alt_txt?.trim()
		notes.push(
			`[Slack image attached: ${fileName(file)}${alt === undefined || alt.length === 0 ? '' : `; alt text: ${alt}`}].`,
		)
		images.push(result.value)
	}
	const body = textOverride ?? message.text ?? ''
	const text = [
		`[Slack message from ${authorLabel(message, botUserID)} at ${message.ts}]`,
		body.trim().length === 0 ? '(no message text)' : body.trim(),
		...notes,
	].join('\n')
	return [{ type: 'text' as const, text }, ...images] satisfies ReadonlyArray<SlackPromptPart>
})

export function chunkSlackMarkdown(text: string): ReadonlyArray<string> {
	const normalized =
		text.trim().length === 0 ? 'Completed without a textual response.' : text.trim()
	const chunks: Array<string> = []
	let remaining = normalized
	while (remaining.length > MAX_SLACK_MARKDOWN_CHARS) {
		const window = remaining.slice(0, MAX_SLACK_MARKDOWN_CHARS)
		const newline = window.lastIndexOf('\n')
		const split = newline >= MAX_SLACK_MARKDOWN_CHARS / 2 ? newline : MAX_SLACK_MARKDOWN_CHARS
		chunks.push(remaining.slice(0, split).trimEnd())
		remaining = remaining.slice(split).trimStart()
	}
	chunks.push(remaining)
	return chunks
}
