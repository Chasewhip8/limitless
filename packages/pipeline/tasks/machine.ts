import { Effect } from 'effect'
import {
	type CommandEvent,
	type CommandReceipt,
	InvalidTransition,
	type StoredCommand,
} from './schema'

export function receipt(command: StoredCommand): CommandReceipt {
	switch (command.delivery._tag) {
		case 'Pending':
			return { ...command, delivery: { _tag: 'Pending', step: command.delivery.step } }
		case 'Unconfirmed':
			return { ...command, delivery: { _tag: 'Unconfirmed' } }
		default:
			return { ...command, delivery: command.delivery }
	}
}

export function deliveryTerminal(command: CommandReceipt): boolean {
	switch (command.delivery._tag) {
		case 'Pending':
		case 'Unconfirmed':
			return false
		default:
			return true
	}
}

export const transition = Effect.fn('Command.transition')(function* (
	command: StoredCommand,
	event: CommandEvent,
) {
	const { delivery } = command
	const next = { ...command, version: command.version + 1 }
	switch (event._tag) {
		case 'CheckoutPrepared':
			if (delivery._tag === 'Pending' && delivery.step === 'checkout' && command.kind === 'review')
				return { ...next, delivery: { ...delivery, step: 'session' } } satisfies StoredCommand
			break
		case 'SessionPrepared':
			if (delivery._tag === 'Pending' && delivery.step === 'session')
				return { ...next, delivery: { ...delivery, step: 'send' } } satisfies StoredCommand
			break
		case 'DeliveryStarted':
			if (delivery._tag === 'Pending' && delivery.step === 'send')
				return {
					...next,
					delivery: { _tag: 'Unconfirmed', payload: delivery.payload },
				} satisfies StoredCommand
			break
		case 'Acknowledged':
			if (
				delivery._tag === 'Unconfirmed' &&
				(command.kind === 'interrupt' || command.messageId === event.nativeRef.messageId)
			)
				return {
					...next,
					delivery: { _tag: 'Acknowledged', nativeRef: event.nativeRef },
				} satisfies StoredCommand
			break
		case 'CancelledBeforeSend':
			if (delivery._tag === 'Pending' && command.kind !== 'interrupt')
				return { ...next, delivery: { _tag: 'CancelledBeforeSend' } } satisfies StoredCommand
			break
		case 'Rejected':
			if (delivery._tag === 'Pending')
				return {
					...next,
					delivery: { _tag: 'Rejected', reason: event.reason },
				} satisfies StoredCommand
			break
	}
	return yield* InvalidTransition.make({
		commandId: command.id,
		event: event._tag,
		state: delivery._tag,
	})
})
