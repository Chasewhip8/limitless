import type { OpenCodeClient } from '@opencode/client/effect'
import { Deferred, Effect, Option, Queue, Schema, Stream } from 'effect'
import { type PrepareInput, WorkspaceError, WorkspaceStatus } from '../workspace/schema'
import { failure, makeConnection, nativeRequest, translateError } from './client'
import type { Worker, WorkerError } from './schema'

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

const runHelper = Effect.fn('OpenCodeWorker.runHelper')(
	function* (
		client: OpenCodeClient,
		command: string,
		metadata: Readonly<Record<string, string | number>>,
		timeout: number,
	) {
		const connected = yield* Deferred.make<void>()
		const changes = yield* Queue.sliding<void, WorkerError>(1)
		yield* client.event.subscribe({ types: ['shell.exited', 'shell.deleted'] }).pipe(
			Stream.runForEach(() =>
				Effect.gen(function* () {
					yield* Deferred.succeed(connected, undefined)
					yield* Queue.offer(changes, undefined)
				}),
			),
			Effect.mapError(translateError),
			Effect.catch((error) => Queue.fail(changes, error)),
			Effect.ensuring(
				Queue.fail(changes, failure('unavailable', 'Native helper event connection ended')),
			),
			Effect.forkScoped,
		)
		yield* Deferred.await(connected).pipe(Effect.timeout('15 seconds'))
		const control = yield* client.location.get().pipe(nativeRequest)
		const location = { directory: control.directory }
		const listed = yield* client.shell.list({ location }).pipe(nativeRequest)
		const matching = listed.data.filter(
			(shell) => shell.command === command && shell.cwd === control.directory,
		)
		if (
			matching.length > 1 ||
			matching.some((shell) =>
				Object.entries(metadata).some(([key, value]) => shell.metadata[key] !== value),
			)
		) {
			return yield* failure(
				'unavailable',
				'Helper ownership is ambiguous; its idempotent operation remains pending',
			)
		}
		const start = Effect.fn('OpenCodeWorker.startHelper')(function* () {
			if (matching[0]) return matching[0]
			const { data } = yield* client.shell
				.create({ location, command, cwd: control.directory, timeout, metadata })
				.pipe(nativeRequest)
			return data
		})
		const invocation = yield* start()
		const read = Effect.fn('OpenCodeWorker.readHelper')(function* () {
			const { data, location: actual } = yield* client.shell
				.get({ location, id: invocation.id })
				.pipe(nativeRequest)
			if (
				actual.directory !== control.directory ||
				data.id !== invocation.id ||
				data.command !== command ||
				data.cwd !== control.directory ||
				Object.entries(metadata).some(([key, value]) => data.metadata[key] !== value)
			) {
				return yield* failure('ownership', 'Native helper command changed identity')
			}
			return data
		})
		const first = yield* read()
		const settled = yield* Stream.succeed(first).pipe(
			Stream.concat(Stream.fromQueue(changes).pipe(Stream.mapEffect(() => read()))),
			Stream.filter((shell) => shell.status !== 'running'),
			Stream.runHead,
			Effect.timeout(timeout + 5000),
		)
		if (Option.isNone(settled))
			return yield* failure('unavailable', 'Native helper stream ended before its response')
		const completed = settled.value
		if (completed.status !== 'exited')
			return yield* failure('unavailable', 'Helper response was interrupted or timed out')
		const response = yield* client.shell
			.output({ location, id: invocation.id, cursor: 0, limit: 65536 })
			.pipe(nativeRequest)
		if (
			response.location.directory !== control.directory ||
			response.data.truncated ||
			response.data.size > 65536 ||
			response.data.cursor !== response.data.size
		) {
			return yield* failure('unavailable', 'Complete helper response was not available')
		}
		const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
			response.data.output,
		)
		const rejected = Schema.decodeUnknownOption(WorkspaceError)(value)
		if (rejected._tag === 'Some') {
			const code = rejected.value.code
			return yield* failure(
				['busy', 'io_failed', 'git_failed', 'archive_failed'].includes(code)
					? 'unavailable'
					: 'workspace',
				`Checkout helper rejected the operation (${code})`,
			)
		}
		if (completed.exit !== 0)
			return yield* failure('unavailable', 'Checkout helper did not confirm success')
		return value
	},
	Effect.scoped,
	Effect.mapError(translateError),
)

export const makeWorkspaces = Effect.gen(function* () {
	const connect = yield* makeConnection
	const check = Effect.fn('OpenCodeWorker.checkHelper')(function* (worker: Worker) {
		const client = yield* connect(worker)
		const value = yield* runHelper(
			client,
			`${quote(worker.helperExecutable)} protocol`,
			{
				pipelineProtocolVersion: 2,
				pipelineWorkerId: worker.id,
			},
			5000,
		)
		yield* Schema.decodeUnknownEffect(Schema.Struct({ protocolVersion: Schema.Literal(2) }))(
			value,
		).pipe(
			Effect.mapError(() => failure('incompatible', 'Worker checkout helper protocol must be 2')),
		)
	})
	const prepare = Effect.fn('OpenCodeWorker.prepare')(function* (
		worker: Worker,
		assignment: { readonly directory: string },
		input: PrepareInput,
	) {
		const client = yield* connect(worker)
		const request = Buffer.from(JSON.stringify({ operation: 'prepare', input })).toString(
			'base64url',
		)
		const command = `${quote(worker.helperExecutable)} workspace --root ${quote(worker.workspaceRoot)} --request ${quote(request)}`
		const value = yield* runHelper(
			client,
			command,
			{ pipelineTaskId: input.taskId, pipelineWorkerId: worker.id },
			120000,
		)
		const status = yield* Schema.decodeUnknownEffect(WorkspaceStatus)(value).pipe(
			Effect.mapError(() => failure('protocol', 'Invalid checkout helper response')),
		)
		if (status.taskId !== input.taskId || status.directory !== assignment.directory) {
			return yield* failure('ownership', 'Checkout helper returned a different task directory')
		}
		return status
	})
	return { check, prepare }
})
