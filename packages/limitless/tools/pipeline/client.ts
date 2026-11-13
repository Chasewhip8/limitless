import { Effect, Option, type Redacted, Ref, Schedule, Schema, Stream } from 'effect'
import { Ndjson } from 'effect/encoding'
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import {
	type ContinueInput,
	canonicalPullRequest,
	InterruptReceipt,
	nativeEvaluationBudgetMs,
	OperationId,
	type OperationInput,
	OperationReceipt,
	OperationView,
	operationSettled,
	type ReviewInput,
} from '../../../pipeline/workflow'

export class PipelineError extends Schema.TaggedError<PipelineError>()('PipelineError', {
	code: Schema.Literals([
		'forbidden',
		'conflict',
		'not_found',
		'admission_unknown',
		'unavailable',
		'protocol',
		'refused',
	]),
	message: Schema.String,
	conflict: Schema.optionalKey(Schema.String),
}) {}

export const WaitUnavailable = Schema.TaggedStruct('Unavailable', {
	operation: OperationId,
	message: Schema.String,
	view: Schema.optionalKey(OperationView),
})
export const WaitResult = Schema.Union([OperationView, WaitUnavailable])
export type WaitResult = typeof WaitResult.Type

const responseDeadlineMs = nativeEvaluationBudgetMs + 15_000
const eventHandshakeDeadlineMs = 10_000
const unavailable = () =>
	PipelineError.make({
		code: 'unavailable',
		message: 'Pipeline could not be reached or did not respond in time.',
	})
const protocolError = () =>
	PipelineError.make({
		code: 'protocol',
		message: 'Pipeline returned an invalid or misrouted response.',
	})

const admissionUnknown = (error: PipelineError) => {
	if (error.code !== 'unavailable' && error.code !== 'protocol') return error
	return PipelineError.make({
		code: 'admission_unknown',
		message: `${error.message} Pipeline may already have accepted this request, and its work may have started. Repeat this exact tool call with identical arguments to recover the accepted or current work; never change the arguments or substitute other work.`,
	})
}

const conflictGuidance: Record<string, string> = {
	stale_operation:
		'The anchor operation is no longer current: later work superseded it. Act on the current operation instead.',
	operation_pending:
		'The anchor operation has not settled. Call pipeline_wait on it, then repeat this exact call.',
	native_unsettled:
		'Native settlement or idleness has not been established; the session may be busy, or its history may be missing or interrupted. Inspect it with pipeline_wait on the anchor operation or in the native session before repeating this exact call.',
	task_closed: 'The review is closed and accepts no further messages.',
	delivery_unconfirmed:
		'Native delivery of an earlier message is unconfirmed and may have started. Followups stay blocked until it resolves; call pipeline_wait on the anchor operation and never resubmit it.',
	session_unavailable: 'The review’s native session is unavailable.',
	version_conflict: 'Pipeline state changed concurrently. Repeat this exact call.',
	observation_timeout:
		'Pipeline could not establish the anchor’s native state or the request’s preconditions within its evaluation budget. Inspect the anchor with pipeline_wait or in the native session, then repeat this exact call.',
}
const ConflictBody = Schema.Struct({ code: Schema.String })
const NotFoundBody = Schema.TaggedStruct('OperationNotFound', {})

const conflictError = Effect.fn('Pipeline.conflictError')(function* (
	response: HttpClientResponse.HttpClientResponse,
) {
	const body = yield* HttpClientResponse.schemaBodyJson(ConflictBody)(response).pipe(Effect.option)
	const code = Option.match(body, { onNone: () => 'unknown', onSome: ({ code }) => code })
	const guidance = conflictGuidance[code] ?? 'Pipeline state conflicts with this request.'
	return yield* PipelineError.make({
		code: 'conflict',
		conflict: code,
		message: `${guidance} Pipeline refused this attempt (${code}), and this attempt submitted nothing new. A refusal does not prove an earlier attempt was not accepted.`,
	})
})

const refusedError = Effect.fn('Pipeline.refusedError')(function* (
	response: HttpClientResponse.HttpClientResponse,
) {
	if (response.status === 404) {
		const missing = yield* HttpClientResponse.schemaBodyJson(NotFoundBody)(response).pipe(
			Effect.option,
		)
		if (Option.isSome(missing))
			return yield* PipelineError.make({
				code: 'not_found',
				message:
					'Pipeline has no such operation. Pass back an operation reference exactly as a Pipeline tool returned it.',
			})
	}
	return yield* PipelineError.make({
		code: 'refused',
		message: `Pipeline refused this request (HTTP ${response.status}). A refusal does not prove an earlier attempt was not accepted; repeat the exact call after repairing credentials, routing, or input.`,
	})
})

const reconnectSchedule = Schedule.max([
	Schedule.min([Schedule.exponential(250), Schedule.spaced(5000)]),
	Schedule.during('2 minutes'),
]).pipe(
	Schedule.setInputType<PipelineError>(),
	Schedule.while(({ input }) => input.code === 'unavailable'),
)

export const makePipelineClient = Effect.fn('Pipeline.makeClient')(function* (config: {
	readonly url: string
	readonly token: Redacted.Redacted<string>
}) {
	const http = (yield* HttpClient.HttpClient).pipe(
		HttpClient.withScope,
		HttpClient.mapRequest(HttpClientRequest.bearerToken(config.token)),
		HttpClient.transformResponse(
			Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error' }),
		),
	)
	const request = Effect.fn('Pipeline.request')(
		function* (
			path: string,
			_deadlineMs: number,
			options: { readonly method?: 'GET' | 'POST'; readonly body?: unknown },
		) {
			const url = new URL(path, config.url)
			if (url.origin !== config.url) return yield* protocolError()
			const request = HttpClientRequest.make(options.method ?? 'GET')(url, {
				accept: 'application/json, application/x-ndjson',
			})
			const body =
				options.body === undefined
					? request
					: HttpClientRequest.bodyText(request, JSON.stringify(options.body), 'application/json')
			const response = yield* http.execute(body).pipe(Effect.mapError(unavailable))
			if (response.status >= 200 && response.status < 300) return response
			if (response.status === 409) return yield* conflictError(response)
			if (
				response.status >= 400 &&
				response.status < 500 &&
				response.status !== 408 &&
				response.status !== 429
			)
				return yield* refusedError(response)
			return yield* unavailable()
		},
		(effect, _path, deadlineMs, _options) =>
			effect.pipe(
				Effect.timeoutOrElse({ duration: deadlineMs, orElse: () => Effect.fail(unavailable()) }),
			),
	)
	const json = Effect.fn('Pipeline.json')(
		function* <S extends Schema.ConstraintDecoder<unknown>>(
			path: string,
			schema: S,
			options: { readonly method?: 'GET' | 'POST'; readonly body?: unknown } = {},
		) {
			const response = yield* request(path, responseDeadlineMs, options)
			return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
				Effect.mapError(protocolError),
			)
		},
		Effect.scoped,
		Effect.timeoutOrElse({
			duration: responseDeadlineMs,
			orElse: () => Effect.fail(unavailable()),
		}),
	)

	const operationPath = (operation: string) => `/operations/${encodeURIComponent(operation)}`
	const review = (input: ReviewInput) =>
		json('/reviews', OperationReceipt, {
			method: 'POST',
			body: { pr: canonicalPullRequest(input.pr) },
		}).pipe(Effect.mapError(admissionUnknown))
	const successor = Effect.fn('Pipeline.successor')(function* (
		action: 'continue' | 'restart',
		{ after }: ContinueInput,
	) {
		const receipt = yield* json(`${operationPath(after)}/${action}`, OperationReceipt, {
			method: 'POST',
		})
		if (receipt.operation === after) return yield* protocolError()
		return receipt
	}, Effect.mapError(admissionUnknown))
	const interrupt = Effect.fn('Pipeline.interrupt')(function* ({ after }: ContinueInput) {
		const receipt = yield* json(`${operationPath(after)}/interrupt`, InterruptReceipt, {
			method: 'POST',
		})
		if (receipt.operation !== after) return yield* protocolError()
		return receipt
	}, Effect.mapError(admissionUnknown))

	const identified = Effect.fn('Pipeline.identified')(function* (
		view: OperationView,
		operation: string,
	) {
		if (view.operation !== operation) return yield* protocolError()
		return view
	})
	const read = Effect.fn('Pipeline.read')(function* (operation: string) {
		const view = yield* json(operationPath(operation), OperationView)
		return yield* identified(view, operation)
	})
	const events = (operation: string) =>
		HttpClientResponse.stream(
			request(`${operationPath(operation)}/events`, eventHandshakeDeadlineMs, {}),
		).pipe(
			Stream.mapError((error) => (error._tag === 'PipelineError' ? error : unavailable())),
			Stream.pipeThroughChannel(Ndjson.decodeSchema(OperationView)({ ignoreEmptyLines: true })),
			Stream.mapError((error) => {
				if (error._tag === 'PipelineError') return error
				if (Ndjson.isNdjsonError(error) && error.unterminated) return unavailable()
				return protocolError()
			}),
			Stream.mapEffect((view) => identified(view, operation)),
		)
	const connection = (operation: string) =>
		events(operation).pipe(Stream.concat(Stream.fail(unavailable())), Stream.scoped)
	const wait = Effect.fn('Pipeline.wait')(function* (
		{ operation }: OperationInput,
		progress: (update: Record<string, string>) => Effect.Effect<void> = () => Effect.void,
	) {
		const latest = yield* Ref.make(Option.none<OperationView>())
		const reported = yield* Ref.make<string | undefined>(undefined)
		const observe = Effect.fn('Pipeline.wait.observe')(function* (view: OperationView) {
			yield* Ref.set(latest, Option.some(view))
			const state = view.state._tag
			const previous = yield* Ref.getAndSet(reported, state)
			if (state !== previous) yield* progress({ operation, state })
		})
		const unavailableResult = Effect.fn('Pipeline.wait.unavailable')(function* (
			error: PipelineError,
		) {
			const view = yield* Ref.get(latest)
			return WaitUnavailable.make({
				operation,
				message: `${error.message} This does not show whether the operation started, is running, or settled. Waiting never submits or interrupts work; call pipeline_wait again with the same operation.`,
				...Option.match(view, { onNone: () => ({}), onSome: (view) => ({ view }) }),
			})
		})

		return yield* connection(operation).pipe(
			Stream.retry(reconnectSchedule),
			Stream.tap(observe),
			Stream.filter(operationSettled),
			Stream.runHead,
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.fail(protocolError()),
					onSome: (view): Effect.Effect<WaitResult> => Effect.succeed(view),
				}),
			),
			Effect.catchIf(
				(error) => error.code === 'unavailable' || error.code === 'protocol',
				unavailableResult,
			),
		)
	})
	return {
		review,
		continue: (input: ContinueInput) => successor('continue', input),
		restart: (input: ContinueInput) => successor('restart', input),
		interrupt,
		read,
		wait,
	}
})
