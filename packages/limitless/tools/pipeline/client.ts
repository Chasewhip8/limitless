import { Effect, Option, type Redacted, Ref, Schedule, Schema, Stream } from 'effect'
import { Ndjson } from 'effect/encoding'
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { interruptIntent, resumeIntent, reviewIntent } from '../../../pipeline/tasks/intent'
import {
	CommandId,
	CommandView,
	DispatchReceipt,
	InterruptRequest,
	ResumeRequest,
	ReviewRequest,
	Task,
	TaskId,
} from '../../../pipeline/tasks/schema'
import {
	AcceptedAdmission,
	type makeReceipts,
	PipelineError,
	type PreparedReceipt,
	type Receipt,
	UnknownAdmission,
} from './receipts'

export const CommandInput = Schema.Struct({ taskId: TaskId, commandId: CommandId })
export type CommandInput = typeof CommandInput.Type
export const WaitInput = Schema.Struct({
	...CommandInput.fields,
	timeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type WaitInput = typeof WaitInput.Type
const Observed = Schema.TaggedStruct('Observed', { view: CommandView })
const Pending = Schema.TaggedStruct('Pending', { view: CommandView })
const Unavailable = Schema.TaggedStruct('Unavailable', {
	...CommandInput.fields,
	message: Schema.String,
	view: Schema.optionalKey(CommandView),
})
export const WaitResult = Schema.Union([Observed, Pending, Unavailable])
export type WaitResult = typeof WaitResult.Type

const requestDeadlineMs = 10000
const unavailable = () =>
	PipelineError.make({
		code: 'unavailable',
		message:
			'Pipeline request outcome is unavailable. A lost response does not prove dispatch failed; recover its receipt or inspect the native session.',
	})
const protocolError = () =>
	PipelineError.make({
		code: 'protocol',
		message:
			'Pipeline returned an invalid or misrouted response. Preserve the existing dispatch receipt; do not infer that the native command failed.',
	})

const identifiesTarget = (view: DispatchReceipt, target: Partial<CommandInput>) => {
	const { task, command } = view
	if (command.taskId !== task.id) return false
	if (target.taskId !== undefined && task.id !== target.taskId) return false
	if (target.commandId !== undefined && command.id !== target.commandId) return false
	if (command.delivery._tag !== 'Acknowledged') return true
	const { nativeRef } = command.delivery
	if (command.messageId !== undefined && nativeRef.messageId !== command.messageId) return false
	return (
		task.placement._tag === 'Assigned' &&
		task.placement.assignment.sessionId === nativeRef.sessionId
	)
}
const validateTarget = Effect.fn('Pipeline.validateTarget')(function* <A extends DispatchReceipt>(
	view: A,
	target: Partial<CommandInput>,
) {
	if (!identifiesTarget(view, target)) return yield* protocolError()
	return view
})

const decodeBody = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, body: string) =>
	Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(body))

const preparedIntent = (receipt: PreparedReceipt) => {
	if (receipt.operation === 'review') {
		const request = decodeBody(ReviewRequest, receipt.body)
		return request === undefined ? undefined : reviewIntent(request)
	}
	if (receipt.targetTaskId === undefined) return undefined
	if (receipt.operation === 'resume') {
		const request = decodeBody(ResumeRequest, receipt.body)
		return request === undefined ? undefined : resumeIntent(receipt.targetTaskId, request)
	}
	const request = decodeBody(InterruptRequest, receipt.body)
	return request === undefined ? undefined : interruptIntent(receipt.targetTaskId, request)
}

const matchesIntent = (receipt: PreparedReceipt, { task, command }: DispatchReceipt) => {
	if (command.kind !== receipt.operation) return false
	if (command.requestHash !== preparedIntent(receipt)) return false
	if (receipt.operation !== 'review') {
		return (
			task.id === receipt.targetTaskId &&
			command.afterCommandId === receipt.afterCommandId &&
			command.id !== receipt.afterCommandId
		)
	}
	return reviewIntent(task.request) === command.requestHash && task.id !== receipt.afterTaskId
}

const observedStates = new Set<CommandView['observation']['_tag']>([
	'Idle',
	'NeedsInput',
	'InputCancelled',
])

export function isObserved(view: CommandView) {
	switch (view.command.delivery._tag) {
		case 'Rejected':
		case 'CancelledBeforeSend':
			return true
		case 'Acknowledged':
			return observedStates.has(view.observation._tag)
		default:
			return false
	}
}

const reconnectSchedule = Schedule.min([Schedule.exponential(250), Schedule.spaced(5000)]).pipe(
	Schedule.setInputType<PipelineError>(),
	Schedule.while(({ input }) => input.code === 'unavailable'),
)

export const makePipelineClient = Effect.fn('Pipeline.makeClient')(function* (
	config: { readonly url: string; readonly token: Redacted.Redacted<string> },
	receipts: Effect.Success<ReturnType<typeof makeReceipts>>,
) {
	const http = (yield* HttpClient.HttpClient).pipe(
		HttpClient.withScope,
		HttpClient.mapRequest(HttpClientRequest.bearerToken(config.token)),
		HttpClient.transformResponse(
			Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error' }),
		),
	)
	const request = Effect.fn('Pipeline.request')(function* (
		path: string,
		options: {
			readonly method?: 'GET' | 'POST'
			readonly body?: string
			readonly key?: string
		} = {},
	) {
		const url = new URL(path, config.url)
		if (url.origin !== config.url) return yield* protocolError()
		const request = HttpClientRequest.make(options.method ?? 'GET')(url, {
			accept: 'application/json, application/x-ndjson',
			headers: options.key === undefined ? {} : { 'idempotency-key': options.key },
		})
		const body =
			options.body === undefined
				? request
				: HttpClientRequest.bodyText(request, options.body, 'application/json')
		const response = yield* http.execute(body).pipe(
			Effect.mapError(unavailable),
			Effect.timeoutOrElse({
				duration: requestDeadlineMs,
				orElse: () => Effect.fail(unavailable()),
			}),
		)
		if (response.status >= 200 && response.status < 300) return response
		if (response.status === 409)
			return yield* PipelineError.make({
				code: 'receipt_conflict',
				message:
					'Pipeline rejected an immutable dispatch intent or a followup blocked by its current dispatch state; no replacement was submitted.',
			})
		if (
			response.status >= 400 &&
			response.status < 500 &&
			response.status !== 408 &&
			response.status !== 429
		)
			return yield* PipelineError.make({
				code: 'refused',
				message: `Pipeline refused this request (HTTP ${response.status}). A refused retry does not prove an earlier attempt was not accepted; any Prepared receipt is kept, so repeat the exact request after repairing credentials, routing, or state.`,
			})
		return yield* unavailable()
	})
	const json = Effect.fn('Pipeline.json')(
		function* <S extends Schema.ConstraintDecoder<unknown>>(
			path: string,
			schema: S,
			options: {
				readonly method?: 'GET' | 'POST'
				readonly body?: string
				readonly key?: string
			} = {},
		) {
			const response = yield* request(path, options)
			return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
				Effect.mapError(protocolError),
			)
		},
		Effect.scoped,
		Effect.timeoutOrElse({ duration: requestDeadlineMs, orElse: () => Effect.fail(unavailable()) }),
	)

	const submit = Effect.fn('Pipeline.submit')(function* (receipt: PreparedReceipt) {
		const dispatch = yield* json(receipt.path, DispatchReceipt, {
			method: 'POST',
			body: receipt.body,
			key: receipt.key,
		})
		if (!identifiesTarget(dispatch, {}) || !matchesIntent(receipt, dispatch))
			return yield* protocolError()
		return dispatch
	})
	const admitPrepared = Effect.fn('Pipeline.admitPrepared')(function* (receipt: PreparedReceipt) {
		const dispatch = yield* submit(receipt).pipe(
			Effect.catchIf(
				(error) => error.code === 'unavailable' || error.code === 'protocol',
				() => Effect.void,
			),
		)
		if (dispatch === undefined)
			return UnknownAdmission.make({
				receipt,
				message:
					'Athena may have accepted this dispatch intent. Repeat the exact original tool request to recover this receipt, never a changed request. Recovery does not replay an unconfirmed native write.',
			})
		const accepted = yield* receipts.accept(
			receipt,
			dispatch.task.id,
			dispatch.command.id,
			dispatch.task.request.pr,
		)
		return AcceptedAdmission.make({
			receipt: accepted,
			taskId: accepted.taskId,
			commandId: accepted.commandId,
		})
	})
	const admit = (receipt: Receipt) => {
		if (receipt._tag === 'Accepted')
			return Effect.succeed(
				AcceptedAdmission.make({ receipt, taskId: receipt.taskId, commandId: receipt.commandId }),
			)
		return admitPrepared(receipt)
	}
	const review = Effect.fn('Pipeline.review')(function* (
		sessionId: string,
		input: Parameters<typeof receipts.review>[1],
	) {
		const receipt = yield* receipts.review(sessionId, input)
		return yield* admit(receipt)
	})
	const resume = Effect.fn('Pipeline.resume')(function* (
		sessionId: string,
		input: Parameters<typeof receipts.resume>[1],
	) {
		const receipt = yield* receipts.resume(sessionId, input)
		return yield* admit(receipt)
	})
	const interrupt = Effect.fn('Pipeline.interrupt')(function* (
		sessionId: string,
		input: Parameters<typeof receipts.interrupt>[1],
	) {
		const receipt = yield* receipts.interrupt(sessionId, input)
		return yield* admit(receipt)
	})
	const close = Effect.fn('Pipeline.close')(function* (taskId: string) {
		const task = yield* json(`/tasks/${encodeURIComponent(taskId)}/close`, Task, { method: 'POST' })
		if (task.id !== taskId) return yield* protocolError()
		return task
	})

	const commandPath = (input: CommandInput) =>
		`/tasks/${encodeURIComponent(input.taskId)}/commands/${encodeURIComponent(input.commandId)}`
	const read = Effect.fn('Pipeline.read')(function* (input: CommandInput) {
		const view = yield* json(commandPath(input), CommandView)
		return yield* validateTarget(view, input)
	})
	const events = (input: CommandInput) =>
		HttpClientResponse.stream(request(`${commandPath(input)}/events`)).pipe(
			Stream.mapError((error) => (error._tag === 'PipelineError' ? error : unavailable())),
			Stream.pipeThroughChannel(Ndjson.decodeSchema(CommandView)({ ignoreEmptyLines: true })),
			Stream.mapError((error) => {
				if (error._tag === 'PipelineError') return error
				if (Ndjson.isNdjsonError(error) && error.unterminated) return unavailable()
				return protocolError()
			}),
			Stream.mapEffect((view) => validateTarget(view, input)),
		)
	const connection = (input: CommandInput) =>
		Stream.fromEffect(read(input)).pipe(
			Stream.flatMap((view) => {
				if (isObserved(view)) return Stream.succeed(view)
				return Stream.succeed(view).pipe(
					Stream.concat(events(input)),
					Stream.concat(Stream.fail(unavailable())),
				)
			}),
			Stream.scoped,
		)
	const wait = Effect.fn('Pipeline.wait')(function* (
		input: WaitInput,
		progress: (update: Record<string, string>) => Effect.Effect<void> = () => Effect.void,
	): Effect.fn.Return<WaitResult> {
		const latest = yield* Ref.make(Option.none<CommandView>())
		const reported = yield* Ref.make<string | undefined>(undefined)
		const observe = Effect.fn('Pipeline.wait.observe')(function* (view: CommandView) {
			yield* Ref.set(latest, Option.some(view))
			const status = `${view.command.delivery._tag}/${view.observation._tag}`
			const signature = JSON.stringify([view.command.delivery, view.observation])
			const previous = yield* Ref.getAndSet(reported, signature)
			if (signature !== previous)
				yield* progress({ taskId: input.taskId, commandId: input.commandId, status })
		})
		const unavailableResult = Effect.fn('Pipeline.wait.unavailable')(function* (message: string) {
			const view = yield* Ref.get(latest)
			return Unavailable.make({
				taskId: input.taskId,
				commandId: input.commandId,
				message,
				...Option.match(view, { onNone: () => ({}), onSome: (view) => ({ view }) }),
			})
		})

		if (input.timeoutMs === 0) {
			return yield* Effect.gen(function* () {
				const view = yield* read(input)
				yield* observe(view)
				if (isObserved(view)) return Observed.make({ view })
				return Pending.make({ view })
			}).pipe(Effect.catch((error) => unavailableResult(error.message)))
		}

		const follow = connection(input).pipe(
			Stream.retry(reconnectSchedule),
			Stream.tap(observe),
			Stream.filter(isObserved),
			Stream.runHead,
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.fail(protocolError()),
					onSome: (view) => Effect.succeed(Observed.make({ view })),
				}),
			),
			Effect.catch((error) => unavailableResult(error.message)),
		)
		if (input.timeoutMs === undefined) return yield* follow
		const result = yield* follow.pipe(Effect.timeoutOption(input.timeoutMs))
		if (Option.isSome(result)) return result.value
		const view = yield* Ref.get(latest)
		if (Option.isSome(view)) return Pending.make({ view: view.value })
		return yield* unavailableResult(
			'Pipeline could not be read before the wait budget expired. Waiting did not submit or interrupt native execution.',
		)
	})
	return { review, resume, interrupt, wait, read, close }
})
