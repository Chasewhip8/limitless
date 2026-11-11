import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Effect, Redacted, Schema } from 'effect'

export class PipelineConfigError extends Schema.TaggedError<PipelineConfigError>()(
	'PipelineConfigError',
	{ message: Schema.String },
) {}

const Options = Schema.Struct({
	pipeline: Schema.optionalKey(
		Schema.Struct({
			enabled: Schema.optionalKey(Schema.Boolean),
			url: Schema.optionalKey(Schema.String),
			tokenFile: Schema.optionalKey(Schema.String),
		}),
	),
})

export type PipelineConfig =
	| { readonly enabled: false }
	| { readonly enabled: true; readonly url: string; readonly tokenFile: string }

export const normalizePipelinePluginConfig = Effect.fn('Pipeline.normalizeConfig')(function* (
	options: unknown,
) {
	const { pipeline } = yield* Schema.decodeUnknownEffect(Options)(options ?? {}).pipe(
		Effect.mapError(() =>
			PipelineConfigError.make({ message: 'Invalid pipeline plugin options.' }),
		),
	)
	if (pipeline?.enabled !== true) return { enabled: false } as const
	const url = yield* Effect.try({
		try: () => new URL(pipeline.url ?? ''),
		catch: () => PipelineConfigError.make({ message: 'pipeline.url must be an HTTPS origin.' }),
	})
	const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
	if (
		(url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
		url.username !== '' ||
		url.password !== '' ||
		url.pathname !== '/' ||
		url.search !== '' ||
		url.hash !== ''
	) {
		return yield* PipelineConfigError.make({
			message: 'pipeline.url must be a fixed HTTPS origin; only loopback fixtures may use HTTP.',
		})
	}
	const tokenFile = pipeline.tokenFile
	if (tokenFile === undefined || !isAbsolute(tokenFile) || tokenFile.startsWith('/nix/store/')) {
		return yield* PipelineConfigError.make({
			message: 'pipeline.tokenFile must be an absolute runtime file outside the Nix store.',
		})
	}
	return { enabled: true, url: url.origin, tokenFile } as const
})

export const readPipelineToken = Effect.fn('Pipeline.readToken')(function* (tokenFile: string) {
	return yield* Effect.tryPromise({
		try: async () => {
			const file = await open(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW)
			try {
				const stat = await file.stat()
				if (
					!stat.isFile() ||
					(stat.mode & 0o077) !== 0 ||
					stat.uid !== process.getuid?.() ||
					stat.size > 65536
				) {
					throw new Error('Unprotected credential file')
				}
				const token = (await file.readFile('utf8')).replace(/\r?\n$/, '')
				if (!/^[\x21-\x7e]{32,}$/.test(token)) throw new Error('Invalid credential')
				return Redacted.make(token)
			} finally {
				await file.close()
			}
		},
		catch: () =>
			PipelineConfigError.make({
				message:
					'Unable to read pipeline.tokenFile: require an owner-only regular file and a single token line of at least 32 characters.',
			}),
	})
})
