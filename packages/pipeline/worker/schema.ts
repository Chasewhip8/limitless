import { Schema } from 'effect'

export const Worker = Schema.Struct({
	id: Schema.String,
	url: Schema.String,
	credentialFile: Schema.String,
	controlDirectory: Schema.String,
	system: Schema.String,
	capacity: Schema.Number,
	openCodeVersion: Schema.String,
})
export type Worker = typeof Worker.Type

export const SessionIdentity = Schema.Struct({
	taskId: Schema.String,
	storageId: Schema.String,
	workspaceId: Schema.String,
	sessionId: Schema.String,
	directory: Schema.String,
})
export type SessionIdentity = typeof SessionIdentity.Type

export const NativeReference = Schema.Struct({
	sessionId: Schema.String,
	messageId: Schema.optionalKey(Schema.String),
})
export type NativeReference = typeof NativeReference.Type

export const NativeObservation = Schema.Union([
	Schema.TaggedStruct('NotObserved', {}),
	Schema.TaggedStruct('Pending', { messageIds: Schema.Array(Schema.String) }),
	Schema.TaggedStruct('Running', { backgroundJobs: Schema.Number }),
	Schema.TaggedStruct('NeedsInput', {
		permissionIds: Schema.Array(Schema.String),
		formIds: Schema.Array(Schema.String),
	}),
	Schema.TaggedStruct('Idle', {}),
	Schema.TaggedStruct('InputCancelled', {}),
	Schema.TaggedStruct('Unavailable', { message: Schema.String }),
]).annotate({
	description:
		'A live OpenCode observation, not a durable task outcome or proof that all OS processes have stopped.',
})
export type NativeObservation = typeof NativeObservation.Type

export class WorkerError extends Schema.TaggedError<WorkerError>()('WorkerError', {
	code: Schema.Literals(['unavailable', 'incompatible', 'ownership', 'protocol']),
	message: Schema.String,
}) {}
