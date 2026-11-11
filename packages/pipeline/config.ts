import path from 'node:path'
import { Context, Effect, FileSystem, Redacted, Schema } from 'effect'
import { Worker } from './worker/schema'

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const AbsolutePath = Schema.NonEmptyString.check(
	Schema.makeFilter((value) => path.isAbsolute(value) || 'Expected an absolute path'),
)
const WorkerConfig = Worker.check(
	Schema.makeFilter((worker) => {
		if (!/^[a-z0-9][a-z0-9-]*$/.test(worker.id)) return 'Invalid worker identifier'
		if (!Number.isSafeInteger(worker.capacity) || worker.capacity < 1)
			return 'Worker capacity must be a positive integer'
		if (!['x86_64-linux', 'aarch64-linux'].includes(worker.system))
			return 'Unsupported worker system'
		if (
			![worker.workspaceRoot, worker.credentialFile, worker.helperExecutable].every(path.isAbsolute)
		)
			return 'Worker paths must be absolute'
		try {
			const url = new URL(worker.url)
			if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
				return 'Worker URL must contain only an origin'
			if (url.protocol === 'https:') return true
			if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
				return true
			return 'Worker URLs must use HTTPS, except on loopback'
		} catch {
			return 'Invalid worker URL'
		}
	}),
)

export const PipelineSettings = Schema.Struct({
	host: Schema.Literals(['127.0.0.1', '::1', 'localhost']),
	port: PositiveInteger.check(Schema.isLessThanOrEqualTo(65535)),
	database: AbsolutePath,
	apiTokenFile: AbsolutePath,
	githubTokenFile: Schema.NullOr(AbsolutePath),
	pollIntervalMs: PositiveInteger,
	queueTimeoutMs: PositiveInteger,
	workers: Schema.Array(WorkerConfig).check(Schema.isMinLength(1)),
}).check(
	Schema.makeFilter(
		(settings) =>
			new Set(settings.workers.map((worker) => worker.id)).size === settings.workers.length ||
			'Worker identifiers must be unique',
	),
)
export type PipelineSettings = typeof PipelineSettings.Type

export class ConfigurationInvalid extends Schema.TaggedError<ConfigurationInvalid>()(
	'ConfigurationInvalid',
	{
		setting: Schema.String,
	},
) {}

export class PipelineConfig extends Context.Service<PipelineConfig, PipelineSettings>()(
	'pipeline/config/PipelineConfig',
) {}

export const loadPipelineConfig = Effect.fn('PipelineConfig.load')(function* (file: string) {
	const fs = yield* FileSystem.FileSystem
	const json = yield* fs
		.readFileString(file)
		.pipe(Effect.mapError(() => ConfigurationInvalid.make({ setting: 'config file' })))
	return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PipelineSettings))(json).pipe(
		Effect.mapError(() => ConfigurationInvalid.make({ setting: 'config schema' })),
	)
})

export const readSecret = Effect.fn('PipelineConfig.readSecret')(function* (file: string) {
	const fs = yield* FileSystem.FileSystem
	const value = yield* fs
		.readFileString(file)
		.pipe(Effect.mapError(() => ConfigurationInvalid.make({ setting: 'credential file' })))
	const secret = value.trim()
	if (secret.length === 0 || /[\r\n]/.test(secret))
		return yield* ConfigurationInvalid.make({
			setting: 'credential file must contain one nonempty line',
		})
	return Redacted.make(secret)
})
