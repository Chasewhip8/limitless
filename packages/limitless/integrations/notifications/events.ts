import { Effect } from 'effect'
import { runCommand } from '../../core/command'
import type { NotificationConfig } from './config'
import type { NotificationEvent } from './schema'

export function isNotificationEventEnabled(
	config: NotificationConfig,
	event: NotificationEvent,
): boolean {
	return config.enabled && config.command !== null && config.events[event]
}

export const runNotificationCommand = Effect.fn('runNotificationCommand')(function* (
	config: NotificationConfig,
	event: NotificationEvent,
) {
	if (!isNotificationEventEnabled(config, event) || config.command === null) return
	const [command, ...args] = config.command
	const result = yield* runCommand(command, args, { timeout: config.timeoutMs })
	if (!result.ok) {
		const detail = result.stderr.length > 0 ? result.stderr : `exitCode=${result.exitCode}`
		yield* Effect.logError(`[limitless] notification command failed for ${event}: ${detail}`)
	}
})
