import { Tool } from '@opencode-ai/schema/tool'
import { Effect, Match } from 'effect'
import {
	FileAccessError,
	FileAccessFailurePayload,
	type ToolFailure,
	type ToolFailurePayload,
	ToolInputError,
	ToolInputFailurePayload,
	ToolOperationError,
	ToolOperationFailurePayload,
} from '../core/errors'
import {
	ToolExecutionContext,
	type ToolExecutionContext as ToolExecutionContextType,
} from '../core/execution'
import { optionalField } from '../lib/type-utils'
import { LspConfig } from '../tools/lsp/config'

export { FileAccessError, ToolInputError, ToolOperationError }
export type { ToolFailure }

export type SessionDirectoryResolver = (
	sessionID: Tool.Context['sessionID'],
) => Effect.Effect<string, Tool.Error>

export type ToolErrorEncoder<Error> = (error: Error) => Tool.Error

export type ToolExecutor = <Input, Output, Error>(
	name: string,
	input: Input,
	context: Tool.Context,
	operation: (input: Input) => Effect.Effect<Output, Error, ToolExecutionContextType | LspConfig>,
	encodeError: ToolErrorEncoder<Error>,
) => Effect.Effect<
	{ readonly output: Output; readonly content: ReadonlyArray<Tool.Content> },
	Tool.Error
>

export function defineLimitlessTool<
	Input extends Tool.ValueSchema,
	Output extends Tool.ValueSchema | undefined,
>(definition: Omit<Tool.Info<Input, Output>, 'options'>): Tool.Info<Input, Output> {
	return { ...definition, options: { codemode: false } }
}

export function failurePayload(error: ToolFailure): ToolFailurePayload {
	return Match.valueTags(error, {
		ToolInputError: (error) =>
			ToolInputFailurePayload.make({
				ok: false,
				error: error._tag,
				tool: error.tool,
				message: error.message,
			}),
		FileAccessError: (error) =>
			FileAccessFailurePayload.make({
				ok: false,
				error: error._tag,
				filePath: error.filePath,
				message: error.message,
			}),
		ToolOperationError: (error) =>
			ToolOperationFailurePayload.make({
				ok: false,
				error: error._tag,
				tool: error.tool,
				message: error.message,
				...optionalField('code', error.code),
			}),
	})
}

export const encodeToolFailure: ToolErrorEncoder<ToolFailure> = (error) =>
	new Tool.Error({ message: error.message, metadata: failurePayload(error) })

export const encodeNoError: ToolErrorEncoder<never> = (error) => error

export function toolModelOutput(input: { readonly output: unknown }): ReadonlyArray<Tool.Content> {
	return [{ type: 'text', text: JSON.stringify(input.output, null, 2) ?? 'null' }]
}

function defectKind(defect: unknown): string {
	if (defect instanceof Error) return defect.name
	return typeof defect
}

export function makeToolExecutor(
	resolveSessionDirectory: SessionDirectoryResolver,
	lspConfig: LspConfig,
): ToolExecutor {
	return (name, input, context, operation, encodeError) =>
		resolveSessionDirectory(context.sessionID).pipe(
			Effect.flatMap((projectRoot) => {
				const execution = ToolExecutionContext.of({
					projectRoot,
					sessionId: context.sessionID,
					agent: context.agent,
				})
				return operation(input).pipe(
					Effect.map((output) => ({ output, content: toolModelOutput({ output }) })),
					Effect.mapError(encodeError),
					Effect.provideService(ToolExecutionContext, execution),
					Effect.provideService(LspConfig, lspConfig),
				)
			}),
			Effect.catchDefect((defect) =>
				Effect.logError(
					`[limitless] ${name} failed with an unexpected ${defectKind(defect)} defect`,
				).pipe(
					Effect.andThen(
						Effect.fail(
							new Tool.Error({
								message: 'Tool execution failed unexpectedly.',
								metadata: { tool: name },
							}),
						),
					),
				),
			),
		)
}
