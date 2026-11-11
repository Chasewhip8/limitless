import { createServer } from 'node:http'
import path from 'node:path'
import { NodeHttpClient, NodeHttpServer, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer } from 'effect'
import { HttpRouter } from 'effect/http'
import { HttpApiBuilder } from 'effect/http-api'
import { PipelineApi } from './api'
import { PipelineConfig, type PipelineSettings } from './config'
import { githubLayer } from './github/service'
import { authorizationLayer, handlersLayer } from './handlers'
import { Scheduler, schedulerLayer } from './scheduler'
import { tasksLayer } from './tasks/service'
import { taskStoreLayer } from './tasks/store'
import { openCodeWorkerLayer } from './worker/service'

export const routesLayer = HttpApiBuilder.layer(PipelineApi).pipe(
	Layer.provide(handlersLayer),
	Layer.provide(authorizationLayer),
)

export const runPipeline = Effect.fn('Pipeline.run')(function* (settings: PipelineSettings) {
	const fs = yield* FileSystem.FileSystem
	yield* fs.makeDirectory(path.dirname(settings.database), { recursive: true, mode: 0o700 })
	const infrastructure = Layer.mergeAll(
		Layer.succeed(PipelineConfig, settings),
		NodeServices.layer,
		NodeHttpClient.layerNodeHttp,
		taskStoreLayer(settings.database),
	)
	const services = Layer.mergeAll(tasksLayer.pipe(Layer.provide(githubLayer)), schedulerLayer).pipe(
		Layer.provide(openCodeWorkerLayer),
		Layer.provideMerge(infrastructure),
	)
	const server = HttpRouter.serve(routesLayer).pipe(
		Layer.provide(NodeHttpServer.layer(createServer, { host: settings.host, port: settings.port })),
	)
	return yield* Effect.gen(function* () {
		const scheduler = yield* Scheduler
		yield* Effect.all([Layer.launch(server), scheduler.run], { concurrency: 2, discard: true })
	}).pipe(Effect.provide(services))
})
