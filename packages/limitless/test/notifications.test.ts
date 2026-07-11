import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { describe, expect, test, vi } from 'vitest'
import { resolveNotificationConfig } from '../index'
import { isNotificationEventEnabled } from '../integrations/notifications/events'
import {
	createNotificationRunner,
	DEFAULT_NOTIFICATION_TIMEOUT_MS,
	type NotificationConfigError,
	normalizeNotificationConfig,
} from '../integrations/notifications/index'

const runEffect = Effect.runPromise

describe('normalizeNotificationConfig', () => {
	test('is disabled by default', async () => {
		const config = await runEffect(normalizeNotificationConfig(undefined))

		expect(config.enabled).toBe(false)
		expect(config.command).toBeNull()
		expect(config.events).toEqual({ complete: true, question: true })
		expect(config.timeoutMs).toBe(DEFAULT_NOTIFICATION_TIMEOUT_MS)
	})

	test('enables a direct command when configured', async () => {
		const config = await runEffect(
			normalizeNotificationConfig({
				notifications: {
					enable: true,
					command: ['notify-send', 'OpenCode needs attention'],
					timeoutMs: 1000,
				},
			}),
		)

		expect(config.enabled).toBe(true)
		expect(config.command).toEqual(['notify-send', 'OpenCode needs attention'])
		expect(config.timeoutMs).toBe(1000)
		expect(isNotificationEventEnabled(config, 'complete')).toBe(true)
		expect(isNotificationEventEnabled(config, 'question')).toBe(true)
	})

	test.each([
		['an empty command', { enable: true, command: [] }],
		['an empty executable', { enable: true, command: [''] }],
		['a non-positive timeout', { enable: true, command: ['notify-send'], timeoutMs: 0 }],
	])('returns a typed error for malformed present config with %s', async (_name, notifications) => {
		const error = await runEffect(normalizeNotificationConfig({ notifications }).pipe(Effect.flip))

		expect(error._tag).toBe('NotificationConfigError')
		expect((error satisfies NotificationConfigError).message).toContain('notifications')
	})

	test('recovers once with a warning at the plugin boundary', async () => {
		const warn = vi.spyOn(console, 'log').mockImplementation(() => {})
		const config = await runEffect(
			resolveNotificationConfig({
				notifications: {
					enable: true,
					command: ['notify-send'],
					events: { complete: 'yes' },
				},
			}),
		)

		expect(config.enabled).toBe(false)
		expect(config.command).toBeNull()
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0]?.join(' ')).toContain('[limitless] invalid notifications config:')
		warn.mockRestore()
	})

	test('respects per-event toggles', async () => {
		const config = await runEffect(
			normalizeNotificationConfig({
				notifications: {
					enable: true,
					command: ['notify-send', 'OpenCode needs attention'],
					events: { complete: false, question: true },
				},
			}),
		)

		expect(isNotificationEventEnabled(config, 'complete')).toBe(false)
		expect(isNotificationEventEnabled(config, 'question')).toBe(true)
	})
})

describe('notification runner', () => {
	test('tracks child sessions, deduplicates idle, resets on busy, and cleans up deletion', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'limitless-notifications-'))
		const marker = join(directory, 'notifications')
		const config = await runEffect(
			normalizeNotificationConfig({
				notifications: {
					enable: true,
					command: [
						process.execPath,
						'-e',
						"require('node:fs').appendFileSync(process.argv[1], 'x')",
						marker,
					],
				},
			}),
		)
		const runner = await runEffect(createNotificationRunner(config))

		try {
			await runEffect(
				Effect.gen(function* () {
					yield* runner.handleEvent({ type: 'unrelated', properties: {} })
					yield* runner.handleEvent({
						type: 'session.created',
						properties: { info: { id: 'child', parentID: 'parent' } },
					})
					yield* runner.handleEvent({
						type: 'session.idle',
						properties: { sessionID: 'child' },
					})
					yield* Effect.all(
						[
							runner.handleEvent({
								type: 'session.idle',
								properties: { sessionID: 'parent' },
							}),
							runner.handleEvent({
								type: 'session.idle',
								properties: { sessionID: 'parent' },
							}),
						],
						{ concurrency: 'unbounded' },
					)
					yield* runner.handleEvent({
						type: 'session.status',
						properties: { sessionID: 'parent', status: { type: 'busy' } },
					})
					yield* runner.handleEvent({
						type: 'session.idle',
						properties: { sessionID: 'parent' },
					})
					yield* runner.handleEvent({
						type: 'session.deleted',
						properties: { info: { id: 'parent' } },
					})
					yield* runner.handleEvent({
						type: 'session.idle',
						properties: { sessionID: 'parent' },
					})
				}),
			)

			expect(readFileSync(marker, 'utf8')).toBe('xxx')
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})
})
