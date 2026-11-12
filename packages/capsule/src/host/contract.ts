import { Rpc } from '@opencode/schema/rpc'
import { Schema } from 'effect'
import { AbsolutePath, CapsuleId } from '../identity'
import { Phase } from '../schema'
import { SourceSpec } from '../source/schema'

export const WorkspaceId = CapsuleId.check(Schema.isStartingWith('wrk_'))
export const SessionId = Schema.String.check(Schema.isStartingWith('ses_'))

export const Owner = Schema.Struct({
	namespace: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
})
export type Owner = typeof Owner.Type

export const HostInfo = Schema.Struct({
	version: Schema.Literal(1),
	storageId: Schema.NonEmptyString,
	checkoutRoot: AbsolutePath,
})
export type HostInfo = typeof HostInfo.Type

export const SessionReference = Schema.Struct({
	storageId: Schema.NonEmptyString,
	workspaceId: WorkspaceId,
	sessionId: SessionId,
	owner: Owner,
})
export type SessionReference = typeof SessionReference.Type

export const PrepareSession = Schema.Struct({
	...SessionReference.fields,
	source: SourceSpec,
	agent: Schema.NonEmptyString,
	metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
})
export type PrepareSession = typeof PrepareSession.Type

export const PreparedSession = Schema.Struct({
	workspaceId: WorkspaceId,
	sessionId: SessionId,
	directory: AbsolutePath,
})
export type PreparedSession = typeof PreparedSession.Type

export const SessionPlacement = Schema.Struct({
	...PreparedSession.fields,
	capsulePhase: Phase,
	workspaceState: Schema.Literals(['bound', 'unprovisioned', 'absent']),
})
export type SessionPlacement = typeof SessionPlacement.Type

export const FailureCode = Schema.Literals([
	'unavailable',
	'incompatible',
	'ownership',
	'invalid_input',
	'not_ready',
])
export type FailureCode = typeof FailureCode.Type

const errors = { rejected: Schema.Struct({ code: FailureCode }) }

export const CapsuleHostRpc = Rpc.define({
	id: 'capsule',
	methods: {
		info: { input: Schema.Struct({}), output: HostInfo, errors },
		prepareSession: { input: PrepareSession, output: PreparedSession, errors },
		getSession: { input: SessionReference, output: SessionPlacement, errors },
	},
	events: {},
})
