import { type ExecFileOptionsWithStringEncoding, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Effect, Schema, SchemaGetter } from 'effect'
import { describeUnknown, objectProperty } from '../lib/guards'

const execFileAsync = promisify(execFile)

export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_BUFFER = 1024 * 1024 * 8

// Command execution options carry AbortSignal and process environment state, so this is the
// sole nonserializable operational type owned by core rather than a Schema model.
export type RunOptions = {
	readonly cwd?: string
	readonly timeout?: number
	readonly maxBuffer?: number
	readonly env?: Readonly<Record<string, string | undefined>>
	readonly signal?: AbortSignal
}

export const TrimmedString = Schema.String.pipe(
	Schema.decode({
		decode: SchemaGetter.transform((value) => value.trim()),
		encode: SchemaGetter.transform((value) => value.trim()),
	}),
)
export type TrimmedString = typeof TrimmedString.Type

export const TrimmedNonEmptyString = TrimmedString.check(Schema.isMinLength(1))
export type TrimmedNonEmptyString = typeof TrimmedNonEmptyString.Type

export const PositiveFiniteTimeout = Schema.Finite.check(Schema.isGreaterThan(0))
export type PositiveFiniteTimeout = typeof PositiveFiniteTimeout.Type

export const CommandResult = Schema.Struct({
	ok: Schema.Boolean,
	exitCode: Schema.NullOr(Schema.Number),
	signal: Schema.optional(Schema.NullOr(Schema.String)),
	stdout: Schema.String,
	stderr: Schema.String,
})
export type CommandResult = typeof CommandResult.Type

export function commandFailure(error: unknown): CommandResult {
	const code = objectProperty(error, 'code')
	const signal = objectProperty(error, 'signal')
	const stdout = objectProperty(error, 'stdout')
	const stderr = objectProperty(error, 'stderr')

	const result = CommandResult.make({
		ok: false,
		exitCode: typeof code === 'number' ? code : null,
		stdout: typeof stdout === 'string' ? stdout : '',
		stderr: typeof stderr === 'string' ? stderr : describeUnknown(error),
	})

	return typeof signal === 'string' ? CommandResult.make({ ...result, signal }) : result
}

export const runCommand = Effect.fn(function* runCommand(
	command: string,
	args: ReadonlyArray<string>,
	options: RunOptions = {},
) {
	const execOptions: ExecFileOptionsWithStringEncoding = {
		env: { ...process.env, ...options.env },
		encoding: 'utf8',
		timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
		maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
	}
	if (options.cwd !== undefined) execOptions.cwd = options.cwd
	if (options.signal !== undefined) execOptions.signal = options.signal

	return yield* Effect.tryPromise({
		try: () => execFileAsync(command, [...args], execOptions),
		catch: commandFailure,
	}).pipe(
		Effect.match({
			onFailure: (failure) => failure,
			onSuccess: (result) =>
				CommandResult.make({
					ok: true,
					exitCode: 0,
					stdout: result.stdout,
					stderr: result.stderr,
				}),
		}),
	)
})
