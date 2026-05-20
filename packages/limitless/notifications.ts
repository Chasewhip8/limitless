import type { PluginOptions } from '@opencode-ai/plugin'
import { Effect } from 'effect'
import { describeUnknown, objectProperty, runCommand } from './shared'

export type NotificationEvent = 'complete' | 'question'

export type NotificationConfig = {
	readonly enabled: boolean
	readonly command: readonly [string, ...string[]] | null
	readonly events: Readonly<Record<NotificationEvent, boolean>>
	readonly includeChildSessions: boolean
	readonly timeoutMs: number
}

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

function booleanProperty(record: object, key: string): boolean | undefined {
	const value = objectProperty(record, key)
	return typeof value === 'boolean' ? value : undefined
}

function finitePositiveProperty(record: object, key: string): number | undefined {
	const value = objectProperty(record, key)
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function parseCommand(value: unknown): readonly [string, ...string[]] | null {
	if (!Array.isArray(value) || value.length === 0) return null
	const [command, ...args] = value
	if (typeof command !== 'string' || command.length === 0) return null
	if (!args.every((arg): arg is string => typeof arg === 'string')) return null
	return [command, ...args]
}

function parseEvents(value: unknown): Readonly<Record<NotificationEvent, boolean>> {
	const raw = asObject(value)
	if (raw === undefined) return defaultEvents

	return {
		complete: booleanProperty(raw, 'complete') ?? defaultEvents.complete,
		question: booleanProperty(raw, 'question') ?? defaultEvents.question,
	}
}

export function normalizeNotificationConfig(
	options: PluginOptions | undefined,
): NotificationConfig {
	const raw = asObject(objectProperty(options, 'notifications'))
	if (raw === undefined) return disabledConfig

	const explicitlyEnabled =
		booleanProperty(raw, 'enable') ?? booleanProperty(raw, 'enabled') ?? false
	const command = parseCommand(objectProperty(raw, 'command'))

	return {
		enabled: explicitlyEnabled && command !== null,
		command,
		events: parseEvents(objectProperty(raw, 'events')),
		includeChildSessions: booleanProperty(raw, 'includeChildSessions') ?? false,
		timeoutMs: finitePositiveProperty(raw, 'timeoutMs') ?? DEFAULT_NOTIFICATION_TIMEOUT_MS,
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
