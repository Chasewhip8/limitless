import { OpenCode } from '@opencode/client/effect'
import { Effect, FileSystem, Option, Redacted, Scope } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from 'effect/http'
import { type Worker, WorkerError } from './schema'

export const failure = (code: WorkerError['code'], message: string) =>
	WorkerError.make({ code, message })

export const translateError = (error: unknown): WorkerError => {
	if (error instanceof WorkerError) return error
	if (typeof error === 'object' && error !== null && '_tag' in error) {
		if (error._tag === 'ClientError' && 'cause' in error) return translateError(error.cause)
		if (error._tag === 'SessionNotFoundError')
			return failure('ownership', 'The retained native session no longer exists')
		if (error._tag === 'SchemaError' || error._tag === 'InvalidRequestError') {
			return failure(
				'protocol',
				'OpenCode returned an invalid response or rejected the native request',
			)
		}
	}
	return failure(
		'unavailable',
		'The native request could not be confirmed; this does not prove it failed',
	)
}

export const nativeRequest = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
	operation.pipe(Effect.timeout('15 seconds'), Effect.scoped, Effect.mapError(translateError))

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
				),
		})
		const credential = yield* fs.readFileString(worker.credentialFile).pipe(
			Effect.map((value) => Redacted.make(value.replace(/[\r\n]+$/, ''))),
			Effect.mapError(() => failure('unavailable', 'Worker credential file could not be read')),
		)
		if (Redacted.value(credential).length === 0)
			return yield* failure('unavailable', 'Worker credential file is empty')
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
				return yield* http
					.execute(HttpClientRequest.basicAuth(request, 'opencode', credential))
					.pipe(
						Effect.provideService(Scope.Scope, scope.value),
						Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error' }),
						Effect.timeout('15 seconds'),
						Effect.catchTag('TimeoutError', () =>
							Effect.fail(
								new HttpClientError.HttpClientError({
									reason: new HttpClientError.TransportError({ request }),
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
