import { timingSafeEqual } from 'node:crypto'
import { Effect, Layer, Redacted } from 'effect'
import { HttpServerResponse } from 'effect/http'
import { HttpApiBuilder } from 'effect/http-api'
import { Authorization, PipelineApi, Unauthorized } from './api'
import { ConfigurationInvalid, PipelineConfig, readSecret } from './config'
import { operationEventBody } from './http-events'
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
	'reviews',
	Effect.fn(function* (handlers) {
		const tasks = yield* Tasks
		const events = Effect.fn('Pipeline.events')(function* (operation: string) {
			const views = yield* tasks.events(operation)
			return HttpServerResponse.stream(operationEventBody(views), {
				contentType: 'application/x-ndjson',
				headers: { 'cache-control': 'no-store' },
			})
		})
		return handlers.handleAll({
			review: ({ payload }) => tasks.review(payload),
			continue: ({ params }) => tasks.continue(params.operation),
			restart: ({ params }) => tasks.restart(params.operation),
			interrupt: ({ params }) => tasks.interrupt(params.operation),
			get: ({ params }) => tasks.get(params.operation),
			events: ({ params }) => events(params.operation),
			health: () => Effect.succeed({ status: 'ok' as const }),
		})
	}),
)
