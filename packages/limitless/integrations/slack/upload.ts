import type { WebClient } from '@slack/web-api'
import { Effect } from 'effect'
import { SLACK_OUTBOUND_UPLOAD_TIMEOUT_MS } from './config'
import { type SlackIntegrationError, slackIntegrationError } from './errors'
import type { SlackQueuedFile, SlackRunnerOptions } from './runtime'

export const uploadSlackFiles = Effect.fn('uploadSlackFiles')(function* (
	uploadClient: WebClient,
	options: SlackRunnerOptions,
	channel: string,
	threadTs: string,
	files: ReadonlyArray<SlackQueuedFile>,
) {
	yield* Effect.tryPromise({
		try: () => {
			const completed: Array<{ id: string; title: string }> = []
			return files
				.reduce(
					(promise, file) =>
						promise.then(() =>
							uploadClient.files
								.getUploadURLExternal({
									filename: file.filename,
									length: file.bytes.byteLength,
								})
								.then((ticket) => {
									if (
										ticket.ok !== true ||
										ticket.file_id === undefined ||
										ticket.upload_url === undefined
									)
										throw new Error(ticket.error ?? 'Slack did not return an upload URL')
									const fileID = ticket.file_id
									const uploadURL = ticket.upload_url
									return options
										.fetch(uploadURL, {
											method: 'POST',
											body: file.bytes,
											signal: AbortSignal.timeout(SLACK_OUTBOUND_UPLOAD_TIMEOUT_MS),
										})
										.then((upload) => {
											if (!upload.ok)
												throw new Error(`Slack file upload returned HTTP ${upload.status}`)
											completed.push({ id: fileID, title: file.filename })
										})
								}),
						),
					Promise.resolve(),
				)
				.then(() =>
					uploadClient.files.completeUploadExternal({
						channel_id: channel,
						thread_ts: threadTs,
						files: completed as [
							{ id: string; title: string },
							...Array<{ id: string; title: string }>,
						],
					}),
				)
				.then((response) => {
					if (response.ok !== true)
						throw new Error(response.error ?? 'Slack did not complete the upload')
				})
		},
		catch: (error): SlackIntegrationError =>
			slackIntegrationError('Slack file upload', `Slack file upload failed: ${String(error)}`),
	})
})
