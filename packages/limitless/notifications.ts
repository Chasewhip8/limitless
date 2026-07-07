import type { PluginOptions } from '@opencode-ai/plugin'
import { Effect, Schema } from 'effect'
import {
	type NotificationConfig,
	type NotificationEvent,
	NotificationOptionsBlock,
} from './lib/notifications'
import { describeUnknown, objectProperty, runCommand } from './shared'

export {
	type NotificationConfig,
	type NotificationEvent,
	NotificationOptionsBlock,
} from './lib/notifications'

export const DEFAULT_NOTIFICATION_TIMEOUT_MS = 5_000

const defaultEvents: Readonly<Record<NotificationEvent, boolean>> = {
	complete: true,
	question: true,
}

const disabledConfig: NotificationConfig = {
	enabled: false,
	command: null,
	events: defaultEvents,
	includeChildSessions: false,
	timeoutMs: DEFAULT_NOTIFICATION_TIMEOUT_MS,
}

function asObject(value: unknown): object | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function parseCommand(
	value: ReadonlyArray<string> | undefined,
): readonly [string, ...string[]] | null {
	if (value === undefined || value.length === 0) return null
	const [command, ...args] = value
	if (command === undefined || command.length === 0) return null
	return [command, ...args]
}

function parseEvents(
	value: typeof NotificationOptionsBlock.Type.events,
): Readonly<Record<NotificationEvent, boolean>> {
	return {
		complete: value?.complete ?? defaultEvents.complete,
		question: value?.question ?? defaultEvents.question,
	}
}

function positiveTimeout(value: number | undefined): number {
	return value === undefined || value <= 0 ? DEFAULT_NOTIFICATION_TIMEOUT_MS : value
}

function warnInvalidConfig(error: unknown): void {
	console.warn(`[limitless] invalid notifications config: ${describeUnknown(error)}`)
}

export function normalizeNotificationConfig(
	options: PluginOptions | undefined,
): NotificationConfig {
	const raw = objectProperty(options, 'notifications')
	if (raw === undefined) return disabledConfig

	let decoded: typeof NotificationOptionsBlock.Type
	try {
		decoded = Schema.decodeUnknownSync(NotificationOptionsBlock)(raw)
	} catch (error) {
		warnInvalidConfig(error)
		return disabledConfig
	}

	const explicitlyEnabled = decoded.enable ?? decoded.enabled ?? false
	const command = parseCommand(decoded.command)

	return {
		enabled: explicitlyEnabled && command !== null,
		command,
		events: parseEvents(decoded.events),
		includeChildSessions: decoded.includeChildSessions ?? false,
		timeoutMs: positiveTimeout(decoded.timeoutMs),
	}
}

export function isNotificationEventEnabled(
	config: NotificationConfig,
	event: NotificationEvent,
): boolean {
	return config.enabled && config.command !== null && config.events[event]
}

async function runNotificationCommand(
	config: NotificationConfig,
	event: NotificationEvent,
): Promise<void> {
	if (!isNotificationEventEnabled(config, event) || config.command === null) return

	const [command, ...args] = config.command
	try {
		const result = await Effect.runPromise(runCommand(command, args, { timeout: config.timeoutMs }))
		if (!result.ok) {
			const detail = result.stderr.length > 0 ? result.stderr : `exitCode=${result.exitCode}`
			console.error(`[limitless] notification command failed for ${event}: ${detail}`)
		}
	} catch (error) {
		console.error(`[limitless] notification command failed for ${event}: ${describeUnknown(error)}`)
	}
}

function stringProperty(record: object | undefined, key: string): string | undefined {
	if (record === undefined) return undefined
	const value = objectProperty(record, key)
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function eventType(event: unknown): string | undefined {
	return stringProperty(asObject(event), 'type')
}

function eventProperties(event: unknown): object | undefined {
	return asObject(objectProperty(event, 'properties'))
}

function sessionIDFromEvent(event: unknown): string | undefined {
	return stringProperty(eventProperties(event), 'sessionID')
}

function lifecycleInfoFromEvent(event: unknown): {
	readonly id: string | undefined
	readonly parentID: string | undefined
} {
	const info = asObject(objectProperty(eventProperties(event), 'info'))
	return {
		id: stringProperty(info, 'id'),
		parentID: stringProperty(info, 'parentID'),
	}
}

function isBusyStatusEvent(event: unknown): boolean {
	const status = asObject(objectProperty(eventProperties(event), 'status'))
	return stringProperty(status, 'type') === 'busy'
}

export function createNotificationRunner(config: NotificationConfig) {
	const childSessionIds = new Set<string>()
	const completedIdleSessionIds = new Set<string>()

	return {
		async notify(event: NotificationEvent): Promise<void> {
			await runNotificationCommand(config, event)
		},

		async handleEvent(event: unknown): Promise<void> {
			if (!config.enabled) return

			const type = eventType(event)
			if (type === 'session.created' || type === 'session.updated') {
				const info = lifecycleInfoFromEvent(event)
				if (info.id !== undefined && info.parentID !== undefined) childSessionIds.add(info.id)
				else if (info.id !== undefined) childSessionIds.delete(info.id)
				return
			}

			if (type === 'session.deleted') {
				const info = lifecycleInfoFromEvent(event)
				if (info.id !== undefined) {
					childSessionIds.delete(info.id)
					completedIdleSessionIds.delete(info.id)
				}
				return
			}

			if (type === 'session.status' && isBusyStatusEvent(event)) {
				const sessionID = sessionIDFromEvent(event)
				if (sessionID !== undefined) completedIdleSessionIds.delete(sessionID)
				return
			}

			if (type !== 'session.idle') return

			const sessionID = sessionIDFromEvent(event)
			if (sessionID !== undefined) {
				if (!config.includeChildSessions && childSessionIds.has(sessionID)) return
				if (completedIdleSessionIds.has(sessionID)) return
				completedIdleSessionIds.add(sessionID)
			}

			await runNotificationCommand(config, 'complete')
		},
	}
}
