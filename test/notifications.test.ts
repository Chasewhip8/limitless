import { describe, expect, test } from 'vitest'
import {
	DEFAULT_NOTIFICATION_TIMEOUT_MS,
	isNotificationEventEnabled,
	normalizeNotificationConfig,
} from '../packages/limitless/notifications'

describe('normalizeNotificationConfig', () => {
	test('is disabled by default', () => {
		const config = normalizeNotificationConfig(undefined)

		expect(config.enabled).toBe(false)
		expect(config.command).toBeNull()
		expect(config.events).toEqual({ complete: true, question: true })
		expect(config.timeoutMs).toBe(DEFAULT_NOTIFICATION_TIMEOUT_MS)
	})

	test('enables a direct command when configured', () => {
		const config = normalizeNotificationConfig({
			notifications: {
				enable: true,
				command: ['notify-send', 'OpenCode needs attention'],
				timeoutMs: 1000,
			},
		})

		expect(config.enabled).toBe(true)
		expect(config.command).toEqual(['notify-send', 'OpenCode needs attention'])
		expect(config.timeoutMs).toBe(1000)
		expect(isNotificationEventEnabled(config, 'complete')).toBe(true)
		expect(isNotificationEventEnabled(config, 'question')).toBe(true)
	})

	test('does not enable without an executable', () => {
		const config = normalizeNotificationConfig({ notifications: { enable: true, command: [] } })

		expect(config.enabled).toBe(false)
		expect(isNotificationEventEnabled(config, 'complete')).toBe(false)
	})

	test('respects per-event toggles', () => {
		const config = normalizeNotificationConfig({
			notifications: {
				enable: true,
				command: ['notify-send', 'OpenCode needs attention'],
				events: { complete: false, question: true },
			},
		})

		expect(isNotificationEventEnabled(config, 'complete')).toBe(false)
		expect(isNotificationEventEnabled(config, 'question')).toBe(true)
	})
})
