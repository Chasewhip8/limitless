import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { resolveNotificationConfig } from '../index'
import { isNotificationEventEnabled } from '../integrations/notifications/events'
import {
	createNotificationRunner,
	DEFAULT_NOTIFICATION_TIMEOUT_MS,
	type NotificationConfigError,
	NotificationSessionLookupError,
	normalizeNotificationConfig,
} from '../integrations/notifications/index'

const runEffect = Effect.runPromise

describe('normalizeNotificationConfig', () => {
	test('is disabled by default', async () => {
		const config = await runEffect(normalizeNotificationConfig(undefined))

		expect(config.enabled).toBe(false)
		expect(config.command).toBeNull()
		expect(config.events).toEqual({ complete: true, permission: true, question: true })
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
		expect(isNotificationEventEnabled(config, 'permission')).toBe(true)
		expect(isNotificationEventEnabled(config, 'question')).toBe(true)
	})

	test('accepts the legacy enabled spelling', async () => {
		const config = await runEffect(
			normalizeNotificationConfig({
				notifications: { enabled: true, command: ['notify-send'] },
			}),
		)

		expect(config.enabled).toBe(true)
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

	test('rejects malformed present config at the plugin boundary', async () => {
		await expect(
			runEffect(
				resolveNotificationConfig({
					notifications: {
						enable: true,
						command: ['notify-send'],
						events: { complete: 'yes' },
					},
				}),
			),
		).rejects.toThrow()
	})

	test('respects per-event toggles', async () => {
		const config = await runEffect(
			normalizeNotificationConfig({
				notifications: {
					enable: true,
					command: ['notify-send', 'OpenCode needs attention'],
					events: { complete: false, permission: false, question: true },
				},
			}),
		)

		expect(isNotificationEventEnabled(config, 'complete')).toBe(false)
		expect(isNotificationEventEnabled(config, 'permission')).toBe(false)
		expect(isNotificationEventEnabled(config, 'question')).toBe(true)
	})
})

describe('notification runner', () => {
	test('handles native V2 permission, question, and every terminal execution event', async () => {
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
		const lookupSession = (sessionID: string) =>
			Effect.succeed(sessionID === 'child' ? { parentID: 'parent' } : {})

		try {
			await runEffect(
				Effect.gen(function* () {
					yield* runner.handleEvent({ type: 'unrelated', data: {} }, lookupSession)
					yield* runner.handleEvent(
						{
							type: 'permission.asked',
							data: { sessionID: 'child', action: 'shell', resource: 'git push' },
						},
						lookupSession,
					)
					yield* runner.handleEvent(
						{
							type: 'form.created',
							data: { form: { sessionID: 'parent' } },
						},
						lookupSession,
					)
					yield* runner.handleEvent(
						{
							type: 'session.execution.succeeded',
							data: { sessionID: 'child' },
						},
						lookupSession,
					)
					yield* runner.handleEvent(
						{
							type: 'session.execution.succeeded',
							data: { sessionID: 'parent' },
						},
						lookupSession,
					)
					yield* runner.handleEvent(
						{
							type: 'session.execution.failed',
							data: { sessionID: 'parent', error: { type: 'test', message: 'failed' } },
						},
						lookupSession,
					)
					yield* runner.handleEvent(
						{
							type: 'session.execution.interrupted',
							data: { sessionID: 'parent', reason: 'user' },
						},
						lookupSession,
					)
				}),
			)

			expect(readFileSync(marker, 'utf8')).toBe('xxxxx')
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})

	test('does not report completion when the session lookup fails', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'limitless-notifications-'))
		const marker = join(directory, 'notifications')
		const config = await runEffect(
			normalizeNotificationConfig({
				notifications: {
					enable: true,
					command: [
						process.execPath,
						'-e',
						"require('node:fs').writeFileSync(process.argv[1], 'x')",
						marker,
					],
				},
			}),
		)
		const runner = await runEffect(createNotificationRunner(config))

		try {
			await runEffect(
				runner.handleEvent(
					{ type: 'session.execution.succeeded', data: { sessionID: 'missing' } },
					() =>
						Effect.fail(new NotificationSessionLookupError({ message: 'session is unavailable' })),
				),
			)
			expect(() => readFileSync(marker, 'utf8')).toThrow()
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})
})
