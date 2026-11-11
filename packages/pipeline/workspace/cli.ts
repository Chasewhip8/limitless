import { Console, Effect, Schema } from 'effect'
import { Command, Flag } from 'effect/cli'
import { protocolVersion, WorkspaceError, WorkspaceRequest } from './schema'
import { make } from './service'

export const protocolCommand = Command.make('protocol', {}, () =>
	Console.log(JSON.stringify({ protocolVersion })),
).pipe(Command.withDescription('Print the standalone workspace helper protocol version as JSON.'))

const decodeRequest = Effect.fn('PipelineCli.decodeWorkspaceRequest')(function* (encoded: string) {
	const json = Buffer.from(encoded, 'base64url').toString('utf8')
	return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceRequest))(json).pipe(
		Effect.mapError(() =>
			WorkspaceError.make({
				code: 'invalid_input',
				message:
					'The workspace request must be valid base64url JSON matching the helper request schema.',
			}),
		),
	)
})

const runWorkspaceRequest = Effect.fn('PipelineCli.runWorkspaceRequest')(function* (
	root: string,
	request: WorkspaceRequest,
) {
	const service = yield* make({ root })
	switch (request.operation) {
		case 'prepare':
			return yield* service.prepare(request.input)
		case 'inspect':
			return yield* service.inspect(request.taskId)
	}
})

export const workspaceCommand = Command.make(
	'workspace',
	{
		root: Flag.String('root').pipe(
			Flag.withDescription('Absolute path to the dedicated retained workspace root.'),
		),
		request: Flag.String('request').pipe(
			Flag.withDescription(
				'Base64url JSON: {operation:"prepare",input} or {operation:"inspect",taskId}. No execution draining or automatic cleanup.',
			),
		),
	},
	Effect.fn('PipelineCli.workspace')(
		function* ({ root, request }) {
			const operation = yield* decodeRequest(request)
			const status = yield* runWorkspaceRequest(root, operation)
			yield* Console.log(JSON.stringify(status))
		},
		Effect.catchTag('WorkspaceError', (error) =>
			Effect.gen(function* () {
				yield* Console.log(
					JSON.stringify({ _tag: error._tag, code: error.code, message: error.message }),
				)
				yield* Effect.sync(() => {
					process.exitCode = 1
				})
			}),
		),
	),
).pipe(
	Command.withDescription(
		'Prepare or inspect a retained independent full clone using the worker’s existing Git credentials. Does not stop OpenCode writers, reset retained work, archive, or release.',
	),
)
