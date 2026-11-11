import { createHash, randomUUID } from 'node:crypto'
import type { Plugin } from '@opencode/plugin/effect'
import { Effect, Schema, Semaphore } from 'effect'
import {
	CommandId,
	InterruptRequest,
	ResumeRequest,
	ReviewRequest,
	TaskId,
} from '../../../pipeline/tasks/schema'

export class PipelineError extends Schema.TaggedError<PipelineError>()('PipelineError', {
	code: Schema.Literals([
		'forbidden',
		'receipt_conflict',
		'receipt_invalid',
		'unavailable',
		'protocol',
		'refused',
	]),
	message: Schema.String,
}) {}

export const ReviewInput = Schema.Struct({
	pr: ReviewRequest.fields.pr,
	system: ReviewRequest.fields.system,
	afterTaskId: Schema.optionalKey(TaskId),
})
export type ReviewInput = typeof ReviewInput.Type
export const ResumeInput = Schema.Struct({ taskId: TaskId, ...ResumeRequest.fields })
export type ResumeInput = typeof ResumeInput.Type
export const InterruptInput = Schema.Struct({ taskId: TaskId, ...InterruptRequest.fields })
export type InterruptInput = typeof InterruptInput.Type

const ReceiptFields = {
	id: Schema.String,
	service: Schema.String,
	sessionId: Schema.String,
	operation: Schema.Literals(['review', 'resume', 'interrupt']),
	requestHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
	afterTaskId: Schema.optionalKey(TaskId),
	afterCommandId: Schema.optionalKey(CommandId),
}
export const PreparedReceipt = Schema.TaggedStruct('Prepared', {
	...ReceiptFields,
	path: Schema.String,
	body: Schema.String,
	key: Schema.String,
	targetTaskId: Schema.optionalKey(TaskId),
	pr: Schema.optionalKey(ReviewRequest.fields.pr),
})
export type PreparedReceipt = typeof PreparedReceipt.Type
export const AcceptedReceipt = Schema.TaggedStruct('Accepted', {
	...ReceiptFields,
	taskId: TaskId,
	commandId: CommandId,
	pr: ReviewRequest.fields.pr,
})
export type AcceptedReceipt = typeof AcceptedReceipt.Type
export const Receipt = Schema.Union([PreparedReceipt, AcceptedReceipt])
export type Receipt = typeof Receipt.Type
export const AcceptedAdmission = Schema.TaggedStruct('Accepted', {
	receipt: AcceptedReceipt,
	taskId: TaskId,
	commandId: CommandId,
})
export const UnknownAdmission = Schema.TaggedStruct('AdmissionUnknown', {
	receipt: PreparedReceipt,
	message: Schema.String,
})
export const Admission = Schema.Union([AcceptedAdmission, UnknownAdmission])
export type Admission = typeof Admission.Type

export const canonicalPullRequest = (pr: string) => pr.replace(/\/$/, '').toLowerCase()
export const requestHash = (body: string) => createHash('sha256').update(body).digest('hex')
export function recoveryRequest(receipt: PreparedReceipt) {
	const body: Record<string, unknown> = JSON.parse(receipt.body)
	if (receipt.operation !== 'review') {
		return {
			tool: `pipeline_${receipt.operation}`,
			input: { taskId: receipt.targetTaskId, ...body },
		}
	}
	return {
		tool: 'pipeline_review',
		input: {
			pr: body.pr,
			...('system' in body ? { system: body.system } : {}),
			...(receipt.afterTaskId === undefined ? {} : { afterTaskId: receipt.afterTaskId }),
		},
	}
}

const prefix = 'pipeline/receipts/'
const receiptPrefix = (service: string, sessionId: string) =>
	`${prefix}${requestHash(JSON.stringify([service, sessionId]))}/`
const receiptId = (
	service: string,
	sessionId: string,
	operation: string,
	slot: ReadonlyArray<string>,
) => receiptPrefix(service, sessionId) + requestHash(JSON.stringify([operation, ...slot]))

export const makeReceipts = Effect.fn('Pipeline.makeReceipts')(function* (
	storage: Plugin.Context['storage'],
	service: string,
) {
	const semaphore = yield* Semaphore.make(1)
	const decode = (value: unknown) =>
		Schema.decodeUnknownEffect(Receipt)(value).pipe(
			Effect.mapError(() =>
				PipelineError.make({
					code: 'receipt_invalid',
					message: 'The durable Pipeline receipt is invalid; do not submit a replacement.',
				}),
			),
		)
	const list = Effect.fn('Pipeline.receipts.list')(function* (sessionId: string) {
		const receipts: Array<Receipt> = []
		const cursor: { after?: string } = {}
		for (;;) {
			const page = yield* storage.scan({
				prefix: receiptPrefix(service, sessionId),
				...cursor,
				limit: 100,
			})
			for (const entry of page.entries) {
				const receipt = yield* decode(entry.value)
				if (receipt.service === service && receipt.sessionId === sessionId) receipts.push(receipt)
			}
			if (page.next === undefined) break
			cursor.after = page.next
		}
		return receipts
	})
	const prepare = Effect.fn('Pipeline.receipts.prepare')(function* (
		sessionId: string,
		operation: PreparedReceipt['operation'],
		slot: ReadonlyArray<string>,
		path: string,
		body: string,
		labels: {
			readonly pr?: string
			readonly afterTaskId?: string
			readonly afterCommandId?: string
			readonly targetTaskId?: string
		} = {},
	) {
		const id = receiptId(service, sessionId, operation, slot)
		const hash = requestHash(body)
		const existing = yield* storage.get(id)
		if (existing !== undefined) {
			const receipt = yield* decode(existing)
			if (
				receipt.id !== id ||
				receipt.service !== service ||
				receipt.sessionId !== sessionId ||
				receipt.operation !== operation
			) {
				return yield* PipelineError.make({
					code: 'receipt_invalid',
					message: 'The durable Pipeline receipt scope is invalid; do not submit a replacement.',
				})
			}
			if (
				receipt.requestHash !== hash ||
				(receipt._tag === 'Prepared' && (receipt.body !== body || receipt.path !== path))
			) {
				return yield* PipelineError.make({
					code: 'receipt_conflict',
					message:
						'Pipeline dispatch intent is immutable. Repeat the exact original request; no new command was submitted.',
				})
			}
			if (
				labels.targetTaskId !== undefined &&
				receipt._tag === 'Accepted' &&
				receipt.taskId !== labels.targetTaskId
			) {
				return yield* PipelineError.make({
					code: 'receipt_invalid',
					message:
						'The accepted Pipeline receipt belongs to a different task; do not submit a replacement.',
				})
			}
			return receipt
		}
		const receipt = PreparedReceipt.make({
			id,
			service,
			sessionId,
			operation,
			path,
			body,
			requestHash: hash,
			key: randomUUID(),
			...labels,
		})
		yield* storage.set(id, receipt)
		return receipt
	})
	const currentReview = Effect.fn('Pipeline.receipts.currentReview')(function* (
		sessionId: string,
		pr: string,
	) {
		const current: { afterTaskId?: string } = {}
		const visited = new Set<string>()
		for (;;) {
			const id = receiptId(service, sessionId, 'review', [pr, current.afterTaskId ?? 'initial'])
			if (visited.has(id))
				return yield* PipelineError.make({
					code: 'receipt_invalid',
					message:
						'The durable Pipeline review receipt chain is invalid; do not submit a replacement.',
				})
			visited.add(id)
			const value = yield* storage.get(id)
			if (value === undefined) return current.afterTaskId
			const receipt = yield* decode(value)
			if (receipt._tag === 'Prepared') return current.afterTaskId
			const successor = yield* storage.get(
				receiptId(service, sessionId, 'review', [pr, receipt.taskId]),
			)
			if (successor === undefined) return current.afterTaskId
			current.afterTaskId = receipt.taskId
		}
	})
	const review = Effect.fn('Pipeline.receipts.review')(function* (
		sessionId: string,
		input: ReviewInput,
	) {
		const pr = canonicalPullRequest(input.pr)
		if (input.afterTaskId !== undefined) {
			const previous = yield* list(sessionId)
			const predecessor = previous.find(
				(receipt) =>
					receipt._tag === 'Accepted' &&
					receipt.operation === 'review' &&
					receipt.taskId === input.afterTaskId,
			)
			if (predecessor === undefined || predecessor.pr !== pr)
				return yield* PipelineError.make({
					code: 'receipt_conflict',
					message:
						'afterTaskId must identify an accepted review receipt for this PR in this caller session.',
				})
		}
		const afterTaskId = input.afterTaskId ?? (yield* currentReview(sessionId, pr))
		const body = JSON.stringify({
			kind: 'review',
			pr,
			...('system' in input ? { system: input.system } : {}),
		})
		return yield* prepare(sessionId, 'review', [pr, afterTaskId ?? 'initial'], '/tasks', body, {
			pr,
			...(afterTaskId === undefined ? {} : { afterTaskId }),
		})
	}, semaphore.withPermit)
	const resume = Effect.fn('Pipeline.receipts.resume')(function* (
		sessionId: string,
		input: ResumeInput,
	) {
		const body = JSON.stringify({ afterCommandId: input.afterCommandId, message: input.message })
		return yield* prepare(
			sessionId,
			'resume',
			[input.taskId, input.afterCommandId],
			`/tasks/${input.taskId}/resume`,
			body,
			{ targetTaskId: input.taskId, afterCommandId: input.afterCommandId },
		)
	}, semaphore.withPermit)
	const interrupt = Effect.fn('Pipeline.receipts.interrupt')(function* (
		sessionId: string,
		input: InterruptInput,
	) {
		const body = JSON.stringify({ afterCommandId: input.afterCommandId })
		return yield* prepare(
			sessionId,
			'interrupt',
			[input.taskId, input.afterCommandId],
			`/tasks/${input.taskId}/interrupt`,
			body,
			{ targetTaskId: input.taskId, afterCommandId: input.afterCommandId },
		)
	}, semaphore.withPermit)
	const accept = Effect.fn('Pipeline.receipts.accept')(function* (
		receipt: PreparedReceipt,
		taskId: string,
		commandId: string,
		pr: string,
	) {
		const value = yield* storage.get(receipt.id)
		const current = yield* decode(value)
		if (
			current.requestHash !== receipt.requestHash ||
			(current._tag === 'Prepared' &&
				(current.key !== receipt.key ||
					current.body !== receipt.body ||
					current.path !== receipt.path))
		) {
			return yield* PipelineError.make({
				code: 'receipt_invalid',
				message:
					'The durable Pipeline receipt changed during admission; do not submit a replacement.',
			})
		}
		if (current._tag === 'Accepted') {
			if (current.taskId !== taskId || current.commandId !== commandId)
				return yield* PipelineError.make({
					code: 'protocol',
					message:
						'Pipeline returned different identities for the same dispatch receipt; preserve the accepted receipt.',
				})
			return current
		}
		const accepted = AcceptedReceipt.make({
			id: current.id,
			service: current.service,
			sessionId: current.sessionId,
			operation: current.operation,
			requestHash: current.requestHash,
			taskId,
			commandId,
			pr: canonicalPullRequest(pr),
			...(current.afterTaskId === undefined ? {} : { afterTaskId: current.afterTaskId }),
			...(current.afterCommandId === undefined ? {} : { afterCommandId: current.afterCommandId }),
		})
		yield* storage.set(receipt.id, accepted)
		return accepted
	}, semaphore.withPermit)
	return { review, resume, interrupt, accept, list }
})
