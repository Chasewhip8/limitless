import { Effect, Result, Schema } from 'effect'
import { DocumentSymbolRequest, WorkspaceSymbolRequest } from 'vscode-languageserver-protocol/node'
import { DEFAULT_TIMEOUT_MS } from '../../core/command'
import { ToolExecutionContext } from '../../core/execution'
import { workspacePath, workspaceRelative, workspaceRoot } from '../../core/paths'
import { loadServerConfigs } from './config'
import {
	maybeLimit,
	request,
	requireCandidates,
	runOnCapableServer,
	uriToFilePath,
	withDocument,
} from './connection'
import { decodeServerValue, lspError } from './errors'
import { LspLocation, LspRange, NonNegativeInteger, PositiveInteger } from './schema'

class NormalizedSymbolModel extends Schema.Class<NormalizedSymbolModel>('NormalizedSymbol')({
	name: Schema.String,
	kind: Schema.optional(NonNegativeInteger),
	detail: Schema.optional(Schema.String),
	filePath: Schema.optional(Schema.String),
	range: Schema.optional(LspRange),
	selectionRange: Schema.optional(LspRange),
	children: Schema.optional(
		Schema.Array(Schema.suspend((): Schema.Codec<NormalizedSymbolModel> => NormalizedSymbolModel)),
	),
}) {}
const NormalizedSymbol = NormalizedSymbolModel

const LspSymbolInformation = Schema.Struct({
	name: Schema.String,
	kind: NonNegativeInteger,
	location: LspLocation,
	containerName: Schema.optional(Schema.String),
})
type LspSymbolInformation = typeof LspSymbolInformation.Type

class LspDocumentSymbolModel extends Schema.Class<LspDocumentSymbolModel>('LspDocumentSymbol')({
	name: Schema.String,
	kind: NonNegativeInteger,
	detail: Schema.optional(Schema.String),
	range: LspRange,
	selectionRange: LspRange,
	children: Schema.optional(
		Schema.Array(
			Schema.suspend((): Schema.Codec<LspDocumentSymbolModel> => LspDocumentSymbolModel),
		),
	),
}) {}
const LspDocumentSymbol = LspDocumentSymbolModel
type LspDocumentSymbol = typeof LspDocumentSymbol.Type
const LspDocumentSymbolsResponse = Schema.NullOr(
	Schema.Array(Schema.Union([LspDocumentSymbol, LspSymbolInformation])),
)
const LspWorkspaceSymbolLocation = Schema.Union([
	LspLocation,
	Schema.Struct({ uri: Schema.String }),
])
const LspWorkspaceSymbol = Schema.Struct({
	name: Schema.String,
	kind: NonNegativeInteger,
	location: LspWorkspaceSymbolLocation,
	containerName: Schema.optional(Schema.String),
})
type LspWorkspaceSymbol = typeof LspWorkspaceSymbol.Type
const LspWorkspaceSymbolsResponse = Schema.NullOr(Schema.Array(LspWorkspaceSymbol))

export const LspSymbolsInput = Schema.Struct({
	workspace: Schema.optional(Schema.String),
	filePath: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
	server: Schema.optional(Schema.String),
	timeoutMs: Schema.optional(PositiveInteger),
	maxResults: Schema.optional(PositiveInteger),
	query: Schema.optional(Schema.String),
})
export type LspSymbolsInput = typeof LspSymbolsInput.Type
const LspWorkspaceSymbolError = Schema.Struct({ server: Schema.String, message: Schema.String })
type LspWorkspaceSymbolError = typeof LspWorkspaceSymbolError.Type
const LspDocumentSymbolsResult = Schema.Struct({
	ok: Schema.Literal(true),
	tool: Schema.Literal('lsp_symbols'),
	mode: Schema.Literal('document'),
	server: Schema.String,
	filePath: Schema.String,
	symbols: Schema.Array(NormalizedSymbol),
	truncated: Schema.Boolean,
})
const LspWorkspaceSymbolsResult = Schema.Struct({
	ok: Schema.Literal(true),
	tool: Schema.Literal('lsp_symbols'),
	mode: Schema.Literal('workspace'),
	query: Schema.String,
	symbols: Schema.Array(NormalizedSymbol),
	truncated: Schema.Boolean,
	errors: Schema.Array(LspWorkspaceSymbolError),
})
export const LspSymbolsResult = Schema.Union([LspDocumentSymbolsResult, LspWorkspaceSymbolsResult])
export type LspSymbolsResult = typeof LspSymbolsResult.Type

function normalizeDocumentSymbol(
	value: LspDocumentSymbol,
	workspace: string,
	filePath: string,
): typeof NormalizedSymbol.Type {
	return NormalizedSymbol.make({
		name: value.name,
		...(value.kind === undefined ? {} : { kind: value.kind }),
		...(value.detail === undefined ? {} : { detail: value.detail }),
		filePath: workspaceRelative(workspace, filePath),
		range: value.range,
		selectionRange: value.selectionRange,
		...(value.children === undefined
			? {}
			: {
					children: value.children.map((child) =>
						normalizeDocumentSymbol(child, workspace, filePath),
					),
				}),
	})
}

const normalizeSymbolInformation = Effect.fn(function* normalizeSymbolInformation(
	tool: string,
	server: string,
	value: LspSymbolInformation | LspWorkspaceSymbol,
	workspace: string,
) {
	const uri = value.location.uri
	const absolutePath = yield* uriToFilePath(tool, server, uri)
	return NormalizedSymbol.make({
		name: value.name,
		kind: value.kind,
		...(value.containerName === undefined ? {} : { detail: value.containerName }),
		...(absolutePath === undefined
			? { filePath: uri }
			: { filePath: workspaceRelative(workspace, absolutePath) }),
		...('range' in value.location ? { range: value.location.range } : {}),
	})
})

const lspSymbolsOperation = Effect.fn(function* lspSymbolsOperation(input: LspSymbolsInput) {
	const context = yield* ToolExecutionContext
	const tool = 'lsp_symbols'
	const workspace = workspaceRoot(input, context.projectRoot)
	const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const filePathInput = input.filePath ?? input.path
	const filePath = filePathInput === undefined ? undefined : workspacePath(workspace, filePathInput)
	const configs = yield* loadServerConfigs(tool)
	const candidates =
		input.query !== undefined && filePath === undefined && input.server === undefined
			? configs
			: yield* requireCandidates(tool, configs, filePath, input.server)
	if (input.query !== undefined) {
		const symbols: Array<typeof NormalizedSymbol.Type> = []
		const errors: Array<LspWorkspaceSymbolError> = []
		let succeeded = 0
		for (const config of candidates) {
			const result = yield* Effect.result(
				runOnCapableServer(
					tool,
					workspace,
					[config],
					'workspaceSymbolProvider',
					timeoutMs,
					(connection) =>
						request(
							tool,
							connection,
							WorkspaceSymbolRequest.type,
							{ query: input.query ?? '' },
							timeoutMs,
						).pipe(
							Effect.flatMap((raw) =>
								decodeServerValue(
									tool,
									connection.config.id,
									'Invalid workspace symbols response',
									LspWorkspaceSymbolsResponse,
									raw,
								),
							),
						),
				),
			)
			if (Result.isSuccess(result)) {
				succeeded += 1
				for (const item of result.success ?? [])
					symbols.push(yield* normalizeSymbolInformation(tool, config.id, item, workspace))
			} else errors.push({ server: config.id, message: result.failure.message })
		}
		if (succeeded === 0 && errors.length > 0) {
			return yield* lspError(
				tool,
				`No workspace symbol provider succeeded. ${errors.map((error) => `${error.server}: ${error.message}`).join('; ')}`,
			)
		}
		const limited = maybeLimit(symbols, input.maxResults)
		return LspSymbolsResult.make({
			ok: true,
			tool,
			mode: 'workspace',
			query: input.query,
			symbols: limited.items,
			truncated: limited.truncated,
			errors,
		})
	}
	if (filePath === undefined) {
		return yield* lspError(
			tool,
			'Provide filePath/path for document symbols or query plus filePath/server for workspace symbols.',
		)
	}
	return yield* runOnCapableServer(
		tool,
		workspace,
		candidates,
		'documentSymbolProvider',
		timeoutMs,
		(connection) =>
			withDocument(tool, connection, filePath, timeoutMs, (document) =>
				Effect.gen(function* () {
					const raw = yield* request(
						tool,
						connection,
						DocumentSymbolRequest.type,
						{ textDocument: { uri: document.uri } },
						timeoutMs,
					)
					const decoded = yield* decodeServerValue(
						tool,
						connection.config.id,
						'Invalid document symbols response',
						LspDocumentSymbolsResponse,
						raw,
					)
					const symbols: Array<typeof NormalizedSymbol.Type> = []
					for (const item of decoded ?? []) {
						symbols.push(
							'range' in item
								? normalizeDocumentSymbol(item, workspace, filePath)
								: yield* normalizeSymbolInformation(tool, connection.config.id, item, workspace),
						)
					}
					const limited = maybeLimit(symbols, input.maxResults)
					return LspSymbolsResult.make({
						ok: true,
						tool,
						mode: 'document',
						server: connection.config.id,
						filePath: workspaceRelative(workspace, filePath),
						symbols: limited.items,
						truncated: limited.truncated,
					})
				}),
			),
	)
})

export const lspSymbols = Effect.fn(function* lspSymbols(input: LspSymbolsInput) {
	return yield* lspSymbolsOperation(input)
})
