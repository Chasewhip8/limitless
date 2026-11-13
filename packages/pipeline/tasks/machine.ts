import { Effect } from 'effect'
import { type CommandEvent, InvalidTransition, type StoredCommand } from './command'

export function deliveryTerminal(command: StoredCommand): boolean {
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
		case 'SessionPrepared':
			if (delivery._tag === 'Pending' && delivery.step === 'session' && command.kind === 'review')
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
