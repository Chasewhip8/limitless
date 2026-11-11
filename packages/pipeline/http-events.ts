import { Stream } from 'effect'
import { Ndjson } from 'effect/encoding'
import { CommandView } from './tasks/schema'

const heartbeat = new TextEncoder().encode('\n')

export const commandEventBody = <E, R>(views: Stream.Stream<CommandView, E, R>) =>
	views.pipe(
		Stream.pipeThroughChannel(Ndjson.encodeSchema(CommandView)()),
		Stream.merge(
			Stream.tick('15 seconds').pipe(
				Stream.drop(1),
				Stream.map(() => heartbeat),
			),
			{
				haltStrategy: 'left',
			},
		),
	)
