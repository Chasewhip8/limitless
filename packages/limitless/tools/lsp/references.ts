import { Effect, Schema } from 'effect'
import { ReferencesRequest } from 'vscode-languageserver-protocol/node'
import { DEFAULT_TIMEOUT_MS } from '../../core/command'
import { ToolExecutionContext } from '../../core/execution'
import { workspaceRelative, workspaceRoot } from '../../core/paths'
import { loadServerConfigs } from './config'
import {
	maybeLimit,
	request,
	requireCandidates,
	resolveFile,
	resolvePosition,
	runOnCapableServer,
	withDocument,
} from './connection'
import { decodeServerValue } from './errors'
import { LspLocationArrayResponse, NormalizedLocation, normalizeLocations } from './locations'
import { LspPosition, NonNegativeInteger, PositiveInteger } from './schema'

export const LspReferencesInput = Schema.Struct({
	workspace: Schema.optional(Schema.String),
	filePath: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
	server: Schema.optional(Schema.String),
	timeoutMs: Schema.optional(PositiveInteger),
	offset: Schema.optional(NonNegativeInteger),
	line: Schema.optional(NonNegativeInteger),
	character: Schema.optional(NonNegativeInteger),
	maxResults: Schema.optional(PositiveInteger),
	includeDeclaration: Schema.optional(Schema.Boolean),
})
export type LspReferencesInput = typeof LspReferencesInput.Type
export const LspReferencesResult = Schema.Struct({
	ok: Schema.Literal(true),
	tool: Schema.Literal('lsp_references'),
	server: Schema.String,
	filePath: Schema.String,
	position: LspPosition,
	locations: Schema.Array(NormalizedLocation),
	truncated: Schema.Boolean,
})
export type LspReferencesResult = typeof LspReferencesResult.Type

const lspReferencesOperation = Effect.fn(function* lspReferencesOperation(
	input: LspReferencesInput,
) {
	const context = yield* ToolExecutionContext
	const tool = 'lsp_references'
	const workspace = workspaceRoot(input, context.projectRoot)
	const filePath = yield* resolveFile(tool, workspace, input)
	const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const configs = yield* loadServerConfigs(tool)
	const candidates = yield* requireCandidates(tool, configs, filePath, input.server)
	return yield* runOnCapableServer(
		tool,
		workspace,
		candidates,
		'referencesProvider',
		timeoutMs,
		(connection) =>
			withDocument(tool, connection, filePath, timeoutMs, (document) =>
				Effect.gen(function* () {
					const position = yield* resolvePosition(tool, document.content, input)
					const raw = yield* request(
						tool,
						connection,
						ReferencesRequest.type,
						{
							textDocument: { uri: document.uri },
							position,
							context: { includeDeclaration: input.includeDeclaration ?? true },
						},
						timeoutMs,
					)
					const decoded = yield* decodeServerValue(
						tool,
						connection.config.id,
						'Invalid references response',
						LspLocationArrayResponse,
						raw,
					)
					const limited = maybeLimit(decoded ?? [], input.maxResults)
					const locations = yield* normalizeLocations(
						tool,
						connection.config.id,
						workspace,
						limited.items,
					)
					return LspReferencesResult.make({
						ok: true,
						tool,
						server: connection.config.id,
						filePath: workspaceRelative(workspace, filePath),
						position,
						locations,
						truncated: limited.truncated,
					})
				}),
			),
	)
})

export const lspReferences = Effect.fn(function* lspReferences(input: LspReferencesInput) {
	return yield* lspReferencesOperation(input)
})
