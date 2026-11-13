import { Schema } from 'effect'
import { NativeResult } from './worker/schema'

export const nativeEvaluationBudgetMs = 180_000

export const OperationId = Schema.String.check(
	Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
).annotate({
	description: 'Opaque Pipeline operation reference. Pass it back unchanged.',
})

export const PullRequestUrl = Schema.String.check(
	Schema.isPattern(
		/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/pull\/[1-9][0-9]*\/?$/,
	),
)
export const canonicalPullRequest = (pr: string) => pr.replace(/\/$/, '').toLowerCase()

export const ReviewInput = Schema.Struct({ pr: PullRequestUrl })
export type ReviewInput = typeof ReviewInput.Type
export const ContinueInput = Schema.Struct({ after: OperationId })
export type ContinueInput = typeof ContinueInput.Type
export const OperationInput = Schema.Struct({ operation: OperationId })
export type OperationInput = typeof OperationInput.Type

export const OperationReceipt = Schema.Struct({
	operation: OperationId,
	pr: PullRequestUrl,
	closed: Schema.Boolean,
})
export type OperationReceipt = typeof OperationReceipt.Type

export const InterruptReceipt = Schema.Struct({
	...OperationReceipt.fields,
	status: Schema.Literals([
		'NotStarted',
		'Requested',
		'DeliveryUnconfirmed',
		'Acknowledged',
		'Rejected',
	]),
})
export type InterruptReceipt = typeof InterruptReceipt.Type

export const NativeSession = Schema.Struct({ server: Schema.String, id: Schema.String })

export const OperationState = Schema.Union([
	NativeResult,
	Schema.TaggedStruct('Queued', {}),
	Schema.TaggedStruct('Preparing', {}),
	Schema.TaggedStruct('DeliveryUnconfirmed', {}),
	Schema.TaggedStruct('Running', {}),
	Schema.TaggedStruct('NeedsInput', {
		permissions: Schema.Int,
		forms: Schema.Int,
	}),
	Schema.TaggedStruct('CancelledBeforeSend', {}),
	Schema.TaggedStruct('Rejected', { message: Schema.String }),
])
export type OperationState = typeof OperationState.Type

export const OperationView = Schema.Struct({
	...OperationReceipt.fields,
	session: Schema.optionalKey(NativeSession),
	state: OperationState,
})
export type OperationView = typeof OperationView.Type

export function operationSettled(view: OperationView): boolean {
	switch (view.state._tag) {
		case 'Pending':
		case 'Queued':
		case 'Preparing':
		case 'DeliveryUnconfirmed':
		case 'Running':
			return false
		default:
			return true
	}
}
