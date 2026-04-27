import { type ExecFileOptionsWithStringEncoding, execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ToolContext, ToolResult } from '@opencode-ai/plugin'
import { Effect, Schema } from 'effect'

const execFileAsync = promisify(execFile)

export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_BUFFER = 1024 * 1024 * 8

export class ToolInputError extends Schema.TaggedErrorClass<ToolInputError>()('ToolInputError', {
	tool: Schema.String,
	message: Schema.String,
}) {}

export class FileAccessError extends Schema.TaggedErrorClass<FileAccessError>()('FileAccessError', {
	filePath: Schema.String,
	message: Schema.String,
}) {}

export class LspToolError extends Schema.TaggedErrorClass<LspToolError>()('LspToolError', {
	tool: Schema.String,
	message: Schema.String,
	server: Schema.optional(Schema.String),
}) {}

export type ToolFailure = ToolInputError | FileAccessError | LspToolError

export type CommandResult = {
	readonly ok: boolean
	readonly exitCode: number | null
	readonly signal?: string | null
	readonly stdout: string
	readonly stderr: string
}

export type RunOptions = {
	readonly cwd?: string
	readonly timeout?: number
	readonly maxBuffer?: number
}

export function objectProperty(value: unknown, key: PropertyKey): unknown {
	if (typeof value !== 'object' || value === null) return undefined
	return Reflect.get(value, key)
}

export function describeUnknown(value: unknown): string {
	if (value instanceof Error) return value.message
	if (typeof value === 'object' && value !== null) {
		try {
			return JSON.stringify(value)
		} catch (error) {
			const fallback = Object.prototype.toString.call(value)
			return error instanceof Error ? `${fallback}: ${error.message}` : fallback
		}
	}
	return String(value)
}

export function isMetadata(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function toToolResult(value: unknown): ToolResult {
	return {
		output: JSON.stringify(value, null, 2),
		metadata: isMetadata(value) ? value : { result: value },
	}
}

export function failurePayload(error: ToolFailure): Record<string, unknown> {
	switch (error._tag) {
		case 'ToolInputError':
			return {
				ok: false,
				error: error._tag,
				tool: error.tool,
				message: error.message,
			}
		case 'FileAccessError':
			return {
				ok: false,
				error: error._tag,
				filePath: error.filePath,
				message: error.message,
			}
		case 'LspToolError': {
			const payload: Record<string, unknown> = {
				ok: false,
				error: error._tag,
				tool: error.tool,
				message: error.message,
			}
			if (error.server !== undefined) payload.server = error.server
			return payload
		}
		default: {
			const exhaustive: never = error
			return {
				ok: false,
				error: 'UnexpectedToolFailure',
				message: describeUnknown(exhaustive),
			}
		}
	}
}

export function executeTool<T>(
	name: string,
	schema: Schema.Decoder<T>,
	input: unknown,
	context: ToolContext,
	body: (args: T, context: ToolContext) => Effect.Effect<unknown, ToolFailure>,
): Promise<ToolResult> {
	return Effect.runPromise(
		Schema.decodeUnknownEffect(schema)(input).pipe(
			Effect.mapError(
				(error) =>
					new ToolInputError({
						tool: name,
						message: String(error),
					}),
			),
			Effect.flatMap((args) => body(args, context)),
			Effect.match({
				onFailure: (error) => toToolResult(failurePayload(error)),
				onSuccess: toToolResult,
			}),
		),
	)
}

export function commandFailure(error: unknown): CommandResult {
	const code = objectProperty(error, 'code')
	const signal = objectProperty(error, 'signal')
	const stdout = objectProperty(error, 'stdout')
	const stderr = objectProperty(error, 'stderr')

	const result: CommandResult = {
		ok: false,
		exitCode: typeof code === 'number' ? code : null,
		stdout: typeof stdout === 'string' ? stdout : '',
		stderr: typeof stderr === 'string' ? stderr : describeUnknown(error),
	}

	return typeof signal === 'string' ? { ...result, signal } : result
}

export function runCommand(command: string, args: ReadonlyArray<string>, options: RunOptions = {}) {
	const execOptions: ExecFileOptionsWithStringEncoding = {
		env: process.env,
		encoding: 'utf8',
		timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
		maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
	}
	if (options.cwd !== undefined) execOptions.cwd = options.cwd

	return Effect.tryPromise({
		try: () => execFileAsync(command, [...args], execOptions),
		catch: commandFailure,
	}).pipe(
		Effect.match({
			onFailure: (failure) => failure,
			onSuccess: (result): CommandResult => ({
				ok: true,
				exitCode: 0,
				stdout: result.stdout,
				stderr: result.stderr,
			}),
		}),
	)
}

function isMissingPathError(error: unknown): boolean {
	const code = objectProperty(error, 'code')
	return code === 'ENOENT' || code === 'ENOTDIR'
}

export function exists(filePath: string): Effect.Effect<boolean, FileAccessError> {
	return Effect.tryPromise({
		try: () => access(filePath),
		catch: (error) => error,
	}).pipe(
		Effect.matchEffect({
			onFailure: (error) =>
				isMissingPathError(error)
					? Effect.succeed(false)
					: Effect.fail(
							new FileAccessError({
								filePath,
								message: describeUnknown(error),
							}),
						),
			onSuccess: () => Effect.succeed(true),
		}),
	)
}

export function findUp(
	names: ReadonlyArray<string>,
	start: string,
): Effect.Effect<string | undefined, FileAccessError> {
	return Effect.gen(function* () {
		let current = path.resolve(start)

		while (true) {
			for (const name of names) {
				const candidate = path.join(current, name)
				if (yield* exists(candidate)) return candidate
			}

			const parent = path.dirname(current)
			if (parent === current) return undefined
			current = parent
		}
	})
}

export function findExecutable(
	name: string,
	start: string,
): Effect.Effect<string, FileAccessError> {
	return findUp([path.join('node_modules', '.bin', name)], start).pipe(
		Effect.map((local) => local ?? name),
	)
}

export function workspaceRoot(
	input: { readonly workspace?: string | undefined },
	context?: Pick<ToolContext, 'worktree' | 'directory'>,
): string {
	return path.resolve(input.workspace ?? context?.worktree ?? context?.directory ?? process.cwd())
}

export function workspacePath(workspace: string, filePath: string): string {
	return path.resolve(workspace, filePath)
}

export function workspaceRelative(workspace: string, filePath: string): string {
	const relative = path.relative(workspace, filePath)
	return relative.length === 0 ? '.' : relative
}
