import type { PluginInput, ToolContext } from '@opencode-ai/plugin'
import { Effect, Schema } from 'effect'
import { ImplementationRequest } from 'vscode-languageserver-protocol/node'
import { DEFAULT_TIMEOUT_MS } from '../../core/command'
import { workspaceRelative, workspaceRoot } from '../../core/paths'
import { loadServerConfigs } from './config'
import {
	request,
	requireCandidates,
	resolveFile,
	resolvePosition,
	runOnCapableServer,
	withCancellation,
	withDocument,
} from './connection'
import { decodeServerValue } from './errors'
import {
	LspLocationResponse,
	locationResponseItems,
	NormalizedLocation,
	normalizeLocationResults,
} from './locations'
import { LspPosition, NonNegativeInteger, PositiveInteger } from './schema'

export const LspImplementationInput = Schema.Struct({
	workspace: Schema.optional(Schema.String),
	filePath: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
	server: Schema.optional(Schema.String),
	timeoutMs: Schema.optional(PositiveInteger),
	offset: Schema.optional(NonNegativeInteger),
	line: Schema.optional(NonNegativeInteger),
	character: Schema.optional(NonNegativeInteger),
	maxResults: Schema.optional(PositiveInteger),
})
export type LspImplementationInput = typeof LspImplementationInput.Type

export const LspImplementationResult = Schema.Struct({
	ok: Schema.Literal(true),
	tool: Schema.Literal('lsp_implementation'),
	server: Schema.String,
	filePath: Schema.String,
	position: LspPosition,
	locations: Schema.Array(NormalizedLocation),
	truncated: Schema.Boolean,
})
export type LspImplementationResult = typeof LspImplementationResult.Type

const lspImplementationOperation = Effect.fn(function* lspImplementationOperation(
	pluginInput: PluginInput,
	input: LspImplementationInput,
	context: ToolContext,
) {
	const tool = 'lsp_implementation' as const
	const workspace = workspaceRoot(input, context)
	const filePath = yield* resolveFile(tool, workspace, input)
	const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const configs = yield* loadServerConfigs(pluginInput, tool, workspace)
	const candidates = yield* requireCandidates(tool, configs, filePath, input.server)
	return yield* runOnCapableServer(
		tool,
		workspace,
		candidates,
		'implementationProvider',
		timeoutMs,
		(connection) =>
			withDocument(tool, connection, filePath, timeoutMs, (document) =>
				Effect.gen(function* () {
					const position = yield* resolvePosition(tool, document.content, input)
					const raw = yield* request(
						tool,
						connection,
						ImplementationRequest.type,
						{ textDocument: { uri: document.uri }, position },
						timeoutMs,
					)
					const decoded = yield* decodeServerValue(
						tool,
						connection.config.id,
						'Invalid implementation response',
						LspLocationResponse,
						raw,
					)
					const normalized = yield* normalizeLocationResults(
						tool,
						connection.config.id,
						workspace,
						locationResponseItems(decoded),
						input.maxResults,
					)
					return LspImplementationResult.make({
						ok: true,
						tool,
						server: connection.config.id,
						filePath: workspaceRelative(workspace, filePath),
						position,
						locations: normalized.locations,
						truncated: normalized.truncated,
					})
				}),
			),
	)
})

export const lspImplementation = Effect.fn(function* lspImplementation(
	pluginInput: PluginInput,
	input: LspImplementationInput,
	context: ToolContext,
) {
	return yield* withCancellation(
		'lsp_implementation',
		context.abort,
		lspImplementationOperation(pluginInput, input, context),
	)
})
