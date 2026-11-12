import { Schema } from 'effect'
import { NativeReference } from '../worker/schema'
import { SourceSpec } from '../worker/source'
import { CommandReceipt, PendingStep, PullRequest, Rejection } from './schema'

const { delivery: _, ...commandFields } = CommandReceipt.fields

export const Payload = Schema.Union([
	Schema.TaggedStruct('Review', { pr: PullRequest, source: SourceSpec, prompt: Schema.String }),
	Schema.TaggedStruct('Resume', { prompt: Schema.String }),
	Schema.TaggedStruct('Interrupt', {}),
])
export type Payload = typeof Payload.Type

export const StoredCommand = Schema.Struct({
	...commandFields,
	delivery: Schema.Union([
		Schema.TaggedStruct('Pending', { step: PendingStep, payload: Payload }),
		Schema.TaggedStruct('Unconfirmed', { payload: Payload }),
		Schema.TaggedStruct('Acknowledged', { nativeRef: NativeReference }),
		Schema.TaggedStruct('CancelledBeforeSend', {}),
		Schema.TaggedStruct('Rejected', { reason: Rejection }),
	]),
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
