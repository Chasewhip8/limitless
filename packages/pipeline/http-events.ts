import { Stream } from 'effect'
import { Ndjson } from 'effect/encoding'
import { OperationView } from './workflow'

const heartbeat = new TextEncoder().encode('\n')

export const operationEventBody = <E, R>(views: Stream.Stream<OperationView, E, R>) =>
	Stream.make(heartbeat).pipe(
		Stream.concat(
			views.pipe(
				Stream.pipeThroughChannel(Ndjson.encodeSchema(OperationView)()),
				Stream.merge(
					Stream.tick('15 seconds').pipe(
						Stream.drop(1),
						Stream.map(() => heartbeat),
					),
					{
						haltStrategy: 'left',
					},
				),
			),
		),
	)
