import { Effect, Result } from 'effect'
import { expect, test } from 'vitest'
import { receipt, transition } from '../tasks/machine'
import { type CommandEvent, StoredCommand } from '../tasks/schema'
import { pullRequest } from './fixtures'

const messageId = 'msg_pipeline22222222222242228222000000000001'
const pending = StoredCommand.make({
	id: '22222222-2222-4222-8222-000000000001',
	taskId: '11111111-1111-4111-8111-000000000001',
	createdAt: 0,
	version: 0,
	kind: 'review',
	messageId,
	requestHash: 'hash',
	delivery: {
		_tag: 'Pending',
		step: 'checkout',
		payload: { _tag: 'Review', pr: pullRequest, prompt: 'Review once.' },
	},
})
const acknowledged: CommandEvent = {
	_tag: 'Acknowledged',
	nativeRef: { sessionId: 'ses_pipeline', messageId },
}

const run = (command: StoredCommand, ...events: ReadonlyArray<CommandEvent>) =>
	Effect.runSync(
		Effect.gen(function* () {
			let current = command
			for (const event of events) current = yield* transition(current, event)
			return current
		}).pipe(Effect.result),
	)
const unconfirmed = Result.getOrThrow(
	run(
		pending,
		{ _tag: 'CheckoutPrepared' },
		{ _tag: 'SessionPrepared' },
		{ _tag: 'DeliveryStarted' },
	),
)

test('possible native delivery can never become unsent or be replaced by a local outcome', () => {
	for (const event of [
		{ _tag: 'CancelledBeforeSend' },
		{ _tag: 'Rejected', reason: { code: 'session_unavailable', message: 'gone' } },
		{ _tag: 'DeliveryStarted' },
		{ _tag: 'SessionPrepared' },
	] satisfies ReadonlyArray<CommandEvent>) {
		expect(Result.isFailure(run(unconfirmed, event))).toBe(true)
	}
})

test('acknowledgment must name the exact message and discards the retained payload', () => {
	const mismatch = run(unconfirmed, {
		_tag: 'Acknowledged',
		nativeRef: { sessionId: 'ses_pipeline', messageId: 'msg_other' },
	})
	expect(Result.isFailure(mismatch)).toBe(true)

	const done = Result.getOrThrow(run(unconfirmed, acknowledged))
	expect(done.delivery).toEqual({ _tag: 'Acknowledged', nativeRef: acknowledged.nativeRef })
	expect(JSON.stringify(done)).not.toContain('Review once.')
	expect(done.version).toBe(4)
})

test('caller receipts never expose the retained exact payload', () => {
	expect(JSON.stringify(receipt(pending))).not.toContain('Review once.')
	expect(JSON.stringify(receipt(unconfirmed))).not.toContain('Review once.')
	expect(receipt(unconfirmed).delivery).toEqual({ _tag: 'Unconfirmed' })
})

test('closing cannot cancel a queued interrupt', () => {
	const { messageId: _, ...base } = pending
	const interrupt = StoredCommand.make({
		...base,
		kind: 'interrupt',
		delivery: { _tag: 'Pending', step: 'session', payload: { _tag: 'Interrupt' } },
	})
	expect(Result.isFailure(run(interrupt, { _tag: 'CancelledBeforeSend' }))).toBe(true)
	expect(Result.isFailure(run(interrupt, { _tag: 'CheckoutPrepared' }))).toBe(true)
})
