import { type ExecFileOptionsWithStringEncoding, execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ToolContext, ToolResult } from '@opencode-ai/plugin'
import { Effect, Match, Schema } from 'effect'
import type { CommandResult, RunOptions } from './lib/command'
import {
	FileAccessError,
	isMissingPath,
	LspToolError,
	type ToolFailure,
	ToolInputError,
} from './lib/errors'

const execFileAsync = promisify(execFile)

export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_BUFFER = 1024 * 1024 * 8

export { FileAccessError, LspToolError, ToolInputError }
export type { CommandResult, RunOptions, ToolFailure }

export function objectProperty(value: unknown, key: PropertyKey): unknown {
	if (typeof value !== 'object' || value === null) return undefined
	return Reflect.get(value, key)
}

export function optionalField<const Key extends string, Value>(
	key: Key,
	value: Value | undefined,
): Partial<Record<Key, Value>> {
	return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>)
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
	return Match.valueTags(error, {
		ToolInputError: (error) => ({
			ok: false,
			error: error._tag,
			tool: error.tool,
			message: error.message,
		}),
		FileAccessError: (error) => ({
			ok: false,
			error: error._tag,
			filePath: error.filePath,
			message: error.message,
		}),
		LspToolError: (error) => ({
			ok: false,
			error: error._tag,
			tool: error.tool,
			message: error.message,
			...optionalField('server', error.server),
		}),
	})
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

export const runCommand = Effect.fn(function* runCommand(
	command: string,
	args: ReadonlyArray<string>,
	options: RunOptions = {},
) {
	const execOptions: ExecFileOptionsWithStringEncoding = {
		env: process.env,
		encoding: 'utf8',
		timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
		maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
	}
	if (options.cwd !== undefined) execOptions.cwd = options.cwd

	return yield* Effect.tryPromise({
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
})

export const exists = Effect.fn(function* exists(filePath: string) {
	return yield* Effect.tryPromise({
		try: () => access(filePath),
		catch: (error) => error,
	}).pipe(
		Effect.matchEffect({
			onFailure: (error) =>
				isMissingPath(error)
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
})

export const findUp = Effect.fn(function* findUp(names: ReadonlyArray<string>, start: string) {
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

export const findExecutable = Effect.fn(function* findExecutable(name: string, start: string) {
	const local = yield* findUp([path.join('node_modules', '.bin', name)], start)
	return local ?? name
})

export function workspaceRoot(
	input: { readonly workspace?: string | undefined },
	context: ToolContext,
): string {
	if (input.workspace === undefined) return path.resolve(context.worktree)
	return path.isAbsolute(input.workspace)
		? path.resolve(input.workspace)
		: path.resolve(context.worktree, input.workspace)
}

export function workspacePath(workspace: string, filePath: string): string {
	return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workspace, filePath)
}

export function workspaceRelative(workspace: string, filePath: string): string {
	const relative = path.relative(workspace, filePath)
	return relative.length === 0 ? '.' : relative
}
