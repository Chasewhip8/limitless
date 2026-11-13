import { Schema } from 'effect'
import { NativeReference } from '../worker/schema'
import { SourceSpec } from '../worker/source'
import { CommandId, PullRequest, Rejection, TaskId } from './schema'

export const Payload = Schema.Union([
	Schema.TaggedStruct('Review', { pr: PullRequest, source: SourceSpec, prompt: Schema.String }),
	Schema.TaggedStruct('Resume', { prompt: Schema.String }),
	Schema.TaggedStruct('Interrupt', {}),
])
export type Payload = typeof Payload.Type

export const StoredCommand = Schema.Struct({
	id: CommandId,
	taskId: TaskId,
	createdAt: Schema.Number,
	version: Schema.Int,
	kind: Schema.Literals(['review', 'resume', 'interrupt']),
	afterCommandId: Schema.optionalKey(CommandId),
	messageId: Schema.optionalKey(Schema.String),
	delivery: Schema.Union([
		Schema.TaggedStruct('Pending', {
			step: Schema.Literals(['session', 'send']),
			payload: Payload,
		}),
		Schema.TaggedStruct('Unconfirmed', { payload: Payload }),
		Schema.TaggedStruct('Acknowledged', { nativeRef: NativeReference }),
		Schema.TaggedStruct('CancelledBeforeSend', {}),
		Schema.TaggedStruct('Rejected', { reason: Rejection }),
	]).annotate({
		description:
			'Delivery only, never execution status. Unconfirmed means a request may have been sent; missing native evidence or idle cannot clear it or authorize replay. Positive exact acknowledgment is required.',
	}),
})
export type StoredCommand = typeof StoredCommand.Type

export const CommandEvent = Schema.Union([
	Schema.TaggedStruct('SessionPrepared', {}),
	Schema.TaggedStruct('DeliveryStarted', {}),
	Schema.TaggedStruct('Acknowledged', { nativeRef: NativeReference }),
	Schema.TaggedStruct('CancelledBeforeSend', {}),
	Schema.TaggedStruct('Rejected', { reason: Rejection }),
])
export type CommandEvent = typeof CommandEvent.Type

export class InvalidTransition extends Schema.TaggedError<InvalidTransition>()(
	'InvalidTransition',
	{ commandId: Schema.String, event: Schema.String, state: Schema.String },
) {}
