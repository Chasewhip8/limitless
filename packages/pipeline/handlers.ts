import { timingSafeEqual } from 'node:crypto'
import { Effect, Layer, Redacted } from 'effect'
import { HttpServerResponse } from 'effect/http'
import { HttpApiBuilder } from 'effect/http-api'
import { Authorization, PipelineApi, Unauthorized } from './api'
import { ConfigurationInvalid, PipelineConfig, readSecret } from './config'
import { commandEventBody } from './http-events'
import { Tasks } from './tasks/service'

export const authorizationLayer = Layer.effect(
	Authorization,
	Effect.gen(function* () {
		const config = yield* PipelineConfig
		const secret = yield* readSecret(config.apiTokenFile)
		if (Redacted.value(secret).length < 32)
			return yield* ConfigurationInvalid.make({
				setting: 'API token must contain at least 32 characters',
			})
		const expected = Buffer.from(Redacted.value(secret))
		return Authorization.of({
			bearer: Effect.fn('Pipeline.authorize')(function* (next, { credential }) {
				const supplied = Buffer.from(Redacted.value(credential))
				if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
					return yield* Unauthorized.make({})
				return yield* next
			}),
		})
	}),
)

export const handlersLayer = HttpApiBuilder.group(
	PipelineApi,
	'tasks',
	Effect.fn(function* (handlers) {
		const tasks = yield* Tasks
		const events = Effect.fn('Pipeline.events')(function* (taskId: string, commandId: string) {
			const views = yield* tasks.events(taskId, commandId)
			return HttpServerResponse.stream(commandEventBody(views), {
				contentType: 'application/x-ndjson',
				headers: { 'cache-control': 'no-store' },
			})
		})
		return handlers.handleAll({
			submit: ({ headers, payload }) => tasks.submit(headers['idempotency-key'], payload),
			resume: ({ params, headers, payload }) =>
				tasks.resume(params.id, headers['idempotency-key'], payload),
			interrupt: ({ params, headers, payload }) =>
				tasks.interrupt(params.id, headers['idempotency-key'], payload),
			close: ({ params }) => tasks.close(params.id),
			get: ({ params }) => tasks.get(params.id),
			getCommand: ({ params }) => tasks.getCommand(params.id, params.commandId),
			events: ({ params }) => events(params.id, params.commandId),
			health: () => Effect.succeed({ status: 'ok' as const }),
		})
	}),
)
