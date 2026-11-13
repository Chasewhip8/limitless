import { FailureCode } from '@limitless/capsule/rpc'
import { OpenCode } from '@opencode/client/effect'
import {
	Cause,
	Context,
	type Duration,
	Effect,
	FileSystem,
	Option,
	Redacted,
	Schema,
	Scope,
} from 'effect'
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from 'effect/http'
import { type Worker, WorkerError, type WorkerFailureReason, type WorkerStage } from './schema'

type FailureDetails = Pick<WorkerError, 'reason' | 'stage' | 'status'>

export const failure = (code: WorkerError['code'], message: string, details: FailureDetails = {}) =>
	WorkerError.make({ code, message, ...details })

const unconfirmed = (reason: WorkerFailureReason, message: string, status?: number) =>
	failure('unavailable', `${message}; this does not prove it failed`, { reason, status })

const hostFailure: Record<FailureCode, WorkerError['code']> = {
	unavailable: 'unavailable',
	not_ready: 'unavailable',
	incompatible: 'incompatible',
	ownership: 'ownership',
	invalid_input: 'protocol',
}

const Rejected = Schema.Struct({ code: FailureCode })

/** Typed RPC failures arrive as plain `{ type, message, data }` values rather than tagged errors. */
const rpcFailure = (error: { readonly type: unknown; readonly data?: unknown }) => {
	const rejected = Schema.decodeUnknownOption(Rejected)(error.data)
	if (error.type === 'rejected' && Option.isSome(rejected)) {
		const { code } = rejected.value
		return failure(hostFailure[code], `The Capsule host refused the request (${code})`, {
			reason: 'rejected',
		})
	}
	switch (error.type) {
		case 'rpc.method_not_found':
			return failure('incompatible', 'The worker does not provide the Capsule host RPC', {
				reason: 'rpc',
			})
		case 'rpc.invalid_input':
		case 'rpc.invalid_output':
			return failure('protocol', 'The Capsule host RPC rejected the request or its response', {
				reason: 'rpc',
			})
		default:
			return unconfirmed('rpc', 'The Capsule host RPC could not be confirmed')
	}
}

/** Retryable statuses mean OpenCode may still accept the same request; others need an operator or a code change. */
const statusFailure = (status: number) => {
	const details = { reason: 'http_status', status } as const
	if (status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600))
		return unconfirmed('http_status', 'OpenCode answered with a transient HTTP status', status)
	if (status === 401 || status === 403)
		return failure('incompatible', 'OpenCode refused the enrolled worker credential', details)
	if (status >= 300 && status < 400)
		return failure('incompatible', 'The enrolled worker origin redirected the request', details)
	return failure('protocol', 'OpenCode rejected the native request', details)
}

const invalidResponse = () =>
	failure('protocol', 'OpenCode returned an invalid native response', { reason: 'decode' })

const httpFailure = (reason: HttpClientError.HttpClientErrorReason) => {
	switch (reason._tag) {
		case 'TransportError':
			if (Cause.isTimeoutError(reason.cause))
				return unconfirmed('timeout', 'The native request exceeded its deadline')
			return unconfirmed('transport', 'The native request could not reach OpenCode')
		case 'InvalidUrlError':
			return failure('incompatible', 'The native request left the enrolled worker origin', {
				reason: 'origin',
			})
		case 'EncodeError':
			return failure('protocol', 'The native request could not be encoded', { reason: 'encode' })
		case 'StatusCodeError':
			return statusFailure(reason.response.status)
		case 'DecodeError':
		case 'EmptyBodyError':
			if (reason.response.status >= 200 && reason.response.status < 300) return invalidResponse()
			return statusFailure(reason.response.status)
	}
}

/** Declared OpenCode errors decode from their response body, so only their documented status remains. */
const declaredStatus: Partial<Record<string, number>> = {
	InvalidRequestError: 400,
	InvalidCursorError: 400,
	UnauthorizedError: 401,
	ForbiddenError: 403,
	LocationNotFoundError: 404,
	ConflictError: 409,
	SessionBusyError: 409,
	UnknownError: 500,
	ServiceUnavailableError: 503,
}

const taggedFailure = (error: { readonly _tag: unknown }): WorkerError => {
	if (error._tag === 'ClientError' && 'cause' in error) return translateError(error.cause)
	if (error._tag === 'SessionNotFoundError')
		return failure('ownership', 'The retained native session no longer exists', {
			reason: 'not_found',
		})
	if (error._tag === 'SchemaError') return invalidResponse()
	if (error._tag === 'Retry')
		return unconfirmed('transport', 'The native event stream asked to reconnect')
	const status = typeof error._tag === 'string' ? declaredStatus[error._tag] : undefined
	if (status !== undefined) return statusFailure(status)
	return unconfirmed('unknown', 'The native request could not be confirmed')
}

/** Classifies a failure into safe fields only; upstream messages, URLs and causes are never copied. */
export const translateError = (error: unknown): WorkerError => {
	if (error instanceof WorkerError) return error
	if (Cause.isTimeoutError(error))
		return unconfirmed('timeout', 'The native request exceeded its deadline')
	if (HttpClientError.isHttpClientError(error)) return httpFailure(error.reason)
	if (typeof error === 'object' && error !== null) {
		if ('_tag' in error) return taggedFailure(error)
		if ('type' in error) return rpcFailure(error)
	}
	return unconfirmed('unknown', 'The native request could not be confirmed')
}

/** Translates a failure and names `stage` unless a narrower native step already did. */
export const translateErrorAt = (stage: WorkerStage) => (error: unknown) => {
	const translated = translateError(error)
	if (translated.stage !== undefined) return translated
	const { code, message, reason, status } = translated
	return WorkerError.make({ code, message, reason, stage, status })
}

export const atStage = (stage: WorkerStage) => Effect.mapError(translateErrorAt(stage))

/** Bounds both the whole native response and each transport attempt of the request it is provided to. */
export const RequestDeadline = Context.Reference<Duration.Input>(
	'pipeline/worker/RequestDeadline',
	{
		defaultValue: () => '15 seconds',
	},
)

export const nativeRequest =
	(stage: WorkerStage) =>
	<A, E, R>(operation: Effect.Effect<A, E, R>) =>
		Effect.gen(function* () {
			const deadline = yield* RequestDeadline
			return yield* operation.pipe(Effect.timeout(deadline))
		}).pipe(Effect.scoped, Effect.mapError(translateErrorAt(stage)))

export const makeConnection = Effect.gen(function* () {
	const http = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope)
	const fs = yield* FileSystem.FileSystem
	return Effect.fn('OpenCodeWorker.connect')(function* (worker: Worker) {
		const origin = yield* Effect.try({
			try: () => {
				const url = new URL(worker.url)
				if (
					!['http:', 'https:'].includes(url.protocol) ||
					(url.protocol === 'http:' &&
						!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
					url.username ||
					url.password ||
					url.pathname !== '/' ||
					url.search ||
					url.hash
				) {
					throw new Error('Invalid enrolled origin')
				}
				return url.origin
			},
			catch: () =>
				failure(
					'incompatible',
					'Worker must be a fixed HTTPS origin; HTTP is allowed only on loopback',
					{ reason: 'origin', stage: 'connect' },
				),
		})
		const credential = yield* fs.readFileString(worker.credentialFile).pipe(
			Effect.map((value) => Redacted.make(value.replace(/[\r\n]+$/, ''))),
			Effect.mapError(() =>
				failure('unavailable', 'Worker credential file could not be read', {
					reason: 'credential',
					stage: 'connect',
				}),
			),
		)
		if (Redacted.value(credential).length === 0)
			return yield* failure('unavailable', 'Worker credential file is empty', {
				reason: 'credential',
				stage: 'connect',
			})
		const authenticated = HttpClient.make(
			Effect.fnUntraced(function* (request, url) {
				if (url.origin !== origin || url.username || url.password) {
					return yield* new HttpClientError.HttpClientError({
						reason: new HttpClientError.InvalidUrlError({ request }),
					})
				}
				const scope = yield* Effect.serviceOption(Scope.Scope)
				if (Option.isNone(scope))
					return yield* new HttpClientError.HttpClientError({
						reason: new HttpClientError.TransportError({
							request,
							description: 'Native response lifetime requires a scope',
						}),
					})
				const deadline = yield* RequestDeadline
				return yield* http
					.execute(HttpClientRequest.basicAuth(request, 'opencode', credential))
					.pipe(
						Effect.provideService(Scope.Scope, scope.value),
						Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error' }),
						Effect.timeout(deadline),
						Effect.catchTag('TimeoutError', (cause) =>
							Effect.fail(
								new HttpClientError.HttpClientError({
									reason: new HttpClientError.TransportError({
										request,
										cause,
										description: 'Native request deadline elapsed',
									}),
								}),
							),
						),
					)
			}),
		).pipe(HttpClient.filterStatus((status) => status < 300 || status >= 400))
		return yield* OpenCode.make({ baseUrl: origin }).pipe(
			Effect.provideService(HttpClient.HttpClient, authenticated),
		)
	})
})
