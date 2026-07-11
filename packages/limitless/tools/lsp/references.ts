import type { PluginInput, ToolContext } from '@opencode-ai/plugin'
import { Effect, Schema } from 'effect'
import { DEFAULT_TIMEOUT_MS } from '../../core/command'
import { workspaceRelative, workspaceRoot } from '../../core/paths'
import { loadServerConfigs } from './config'
import {
	maybeLimit,
	readRangeText,
	request,
	requireCandidates,
	resolveFile,
	resolvePosition,
	runOnCapableServer,
	uriToFilePath,
	withCancellation,
	withDocument,
} from './connection'
import { decodeServerValue } from './errors'
import {
	LspLocation,
	LspPosition,
	LspRange,
	LspTextDocumentIdentifier,
	NonNegativeInteger,
	PositiveInteger,
} from './schema'

const LspLocationLink = Schema.Struct({
	targetUri: Schema.String,
	targetRange: LspRange,
	targetSelectionRange: LspRange,
})
const LspReferenceLocation = Schema.Union([LspLocation, LspLocationLink])
type LspReferenceLocation = typeof LspReferenceLocation.Type
const NormalizedLocation = Schema.Struct({
	uri: Schema.String,
	filePath: Schema.String,
	range: LspRange,
	text: Schema.optional(Schema.String),
})
const LspReferencesParams = Schema.Struct({
	textDocument: LspTextDocumentIdentifier,
	position: LspPosition,
	context: Schema.Struct({ includeDeclaration: Schema.Boolean }),
})
const LspReferencesResponse = Schema.NullOr(Schema.Array(LspReferenceLocation))

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

const normalizeLocation = Effect.fn(function* normalizeLocation(
	tool: string,
	server: string,
	workspace: string,
	value: LspReferenceLocation,
) {
	const uri = 'uri' in value ? value.uri : value.targetUri
	const range = 'uri' in value ? value.range : (value.targetSelectionRange ?? value.targetRange)
	const absolutePath = yield* uriToFilePath(tool, server, uri)
	const filePath = absolutePath === undefined ? uri : workspaceRelative(workspace, absolutePath)
	if (absolutePath === undefined) return NormalizedLocation.make({ uri, filePath, range })
	const text = yield* readRangeText(tool, server, absolutePath, range).pipe(
		Effect.catch((error) =>
			Effect.logWarning(
				`[limitless] ${tool} could not enrich ${filePath} with source text: ${error.message}`,
			).pipe(Effect.as(undefined)),
		),
	)
	return NormalizedLocation.make({
		uri,
		filePath,
		range,
		...(text === undefined ? {} : { text }),
	})
})

function normalizeLocations(
	tool: string,
	server: string,
	workspace: string,
	locations: ReadonlyArray<LspReferenceLocation>,
) {
	return Effect.forEach(locations, (location) =>
		normalizeLocation(tool, server, workspace, location),
	)
}

const lspReferencesOperation = Effect.fn(function* lspReferencesOperation(
	pluginInput: PluginInput,
	input: LspReferencesInput,
	context: ToolContext,
) {
	const tool = 'lsp_references'
	const workspace = workspaceRoot(input, context)
	const filePath = yield* resolveFile(tool, workspace, input)
	const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const configs = yield* loadServerConfigs(pluginInput, tool, workspace)
	const candidates = yield* requireCandidates(tool, configs, filePath, input.server)
	return yield* runOnCapableServer(
		tool,
		workspace,
		candidates,
		'referencesProvider',
		timeoutMs,
		(connection) =>
			withDocument(tool, connection, filePath, (document) =>
				Effect.gen(function* () {
					const position = yield* resolvePosition(tool, document.content, input)
					const raw = yield* request(
						tool,
						connection,
						'textDocument/references',
						LspReferencesParams.make({
							textDocument: { uri: document.uri },
							position,
							context: { includeDeclaration: input.includeDeclaration ?? true },
						}),
						timeoutMs,
					)
					const decoded = yield* decodeServerValue(
						tool,
						connection.config.id,
						'Invalid references response',
						LspReferencesResponse,
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

export const lspReferences = Effect.fn(function* lspReferences(
	pluginInput: PluginInput,
	input: LspReferencesInput,
	context: ToolContext,
) {
	return yield* withCancellation(
		'lsp_references',
		context.abort,
		lspReferencesOperation(pluginInput, input, context),
	)
})
