import { Effect, Option, Ref, Schema } from 'effect'
import { PrepareRenameRequest, RenameRequest } from 'vscode-languageserver-protocol/node'
import { DEFAULT_TIMEOUT_MS } from '../../core/command'
import { ToolExecutionContext } from '../../core/execution'
import { workspaceRelative, workspaceRoot } from '../../core/paths'
import { loadServerConfigs } from './config'
import {
	hasPrepareRename,
	request,
	requireCandidates,
	resolveFile,
	resolvePosition,
	runOnCapableServer,
	uriToFilePath,
	withDocument,
} from './connection'
import { decodeServerValue, lspError } from './errors'
import { LspPosition, LspRange, NonNegativeInteger, PositiveInteger } from './schema'

const NormalizedEdit = Schema.Struct({
	filePath: Schema.String,
	range: LspRange,
	newText: Schema.String,
})
const WorkspaceEditPreview = Schema.Struct({
	edits: Schema.Array(NormalizedEdit),
	unsupportedChanges: Schema.Array(Schema.Unknown),
})
const LspPrepareRenameResponse = Schema.NullOr(
	Schema.Union([
		LspRange,
		Schema.Struct({ range: LspRange, placeholder: Schema.optional(Schema.String) }),
		Schema.Struct({ defaultBehavior: Schema.Literal(true) }),
	]),
)
const LspTextEdit = Schema.Struct({ range: LspRange, newText: Schema.String })
type LspTextEdit = typeof LspTextEdit.Type
const LspTextDocumentEdit = Schema.Struct({
	textDocument: Schema.Struct({
		uri: Schema.String,
		version: Schema.optional(Schema.NullOr(NonNegativeInteger)),
	}),
	edits: Schema.Array(LspTextEdit),
})
const LspWorkspaceEdit = Schema.Struct({
	changes: Schema.optional(Schema.Record(Schema.String, Schema.Array(LspTextEdit))),
	documentChanges: Schema.optional(Schema.Array(Schema.Unknown)),
})
const LspRenameResponse = Schema.NullOr(LspWorkspaceEdit)

export const LspRenameInput = Schema.Struct({
	workspace: Schema.optional(Schema.String),
	filePath: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
	server: Schema.optional(Schema.String),
	timeoutMs: Schema.optional(PositiveInteger),
	offset: Schema.optional(NonNegativeInteger),
	line: Schema.optional(NonNegativeInteger),
	character: Schema.optional(NonNegativeInteger),
	newName: Schema.String,
})
export type LspRenameInput = typeof LspRenameInput.Type
const LspRenameResultFields = {
	tool: Schema.Literal('lsp_rename'),
	server: Schema.String,
	filePath: Schema.String,
	position: LspPosition,
	newName: Schema.String,
	mode: Schema.Literal('preview'),
	applied: Schema.Literal(false),
	edits: Schema.Array(NormalizedEdit),
}
const LspCompleteRenameResult = Schema.Struct({
	...LspRenameResultFields,
	ok: Schema.Literal(true),
	unsupportedChanges: Schema.Tuple([]),
})
const LspPartialRenameResult = Schema.Struct({
	...LspRenameResultFields,
	ok: Schema.Literal(false),
	unsupportedChanges: Schema.NonEmptyArray(Schema.Unknown),
})
export const LspRenameResult = Schema.Union([LspCompleteRenameResult, LspPartialRenameResult])
export type LspRenameResult = typeof LspRenameResult.Type

const normalizeEdit = Effect.fn(function* normalizeEdit(
	tool: string,
	server: string,
	workspace: string,
	uri: string,
	edit: LspTextEdit,
) {
	const absolutePath = yield* uriToFilePath(tool, server, uri)
	return NormalizedEdit.make({
		filePath: absolutePath === undefined ? uri : workspaceRelative(workspace, absolutePath),
		range: edit.range,
		newText: edit.newText,
	})
})

const collectWorkspaceEdits = Effect.fn(function* collectWorkspaceEdits(
	tool: string,
	server: string,
	workspace: string,
	workspaceEdit: typeof LspWorkspaceEdit.Type,
) {
	const edits: Array<typeof NormalizedEdit.Type> = []
	const unsupportedChanges: Array<unknown> = []
	for (const [uri, rawEdits] of Object.entries(workspaceEdit.changes ?? {})) {
		for (const edit of rawEdits) {
			edits.push(yield* normalizeEdit(tool, server, workspace, uri, edit))
		}
	}
	for (const documentChange of workspaceEdit.documentChanges ?? []) {
		const decoded = Schema.decodeUnknownOption(LspTextDocumentEdit)(documentChange)
		if (Option.isNone(decoded)) {
			unsupportedChanges.push(documentChange)
			continue
		}
		for (const edit of decoded.value.edits) {
			edits.push(
				yield* normalizeEdit(tool, server, workspace, decoded.value.textDocument.uri, edit),
			)
		}
	}
	return WorkspaceEditPreview.make({ edits, unsupportedChanges })
})

const lspRenameOperation = Effect.fn(function* lspRenameOperation(input: LspRenameInput) {
	const context = yield* ToolExecutionContext
	const tool = 'lsp_rename' as const
	const workspace = workspaceRoot(input, context.projectRoot)
	const filePath = yield* resolveFile(tool, workspace, input)
	const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const configs = yield* loadServerConfigs(tool)
	const candidates = yield* requireCandidates(tool, configs, filePath, input.server)
	return yield* runOnCapableServer(
		tool,
		workspace,
		candidates,
		'renameProvider',
		timeoutMs,
		(connection) =>
			withDocument(tool, connection, filePath, timeoutMs, (document) =>
				Effect.gen(function* () {
					const position = yield* resolvePosition(tool, document.content, input)
					const capabilities = yield* Ref.get(connection.capabilities)
					if (hasPrepareRename(capabilities)) {
						const raw = yield* request(
							tool,
							connection,
							PrepareRenameRequest.type,
							{ textDocument: { uri: document.uri }, position },
							timeoutMs,
						)
						const prepare = yield* decodeServerValue(
							tool,
							connection.config.id,
							'Invalid prepareRename response',
							LspPrepareRenameResponse,
							raw,
						)
						if (prepare === null)
							return yield* lspError(
								tool,
								'Server rejected rename at this position.',
								connection.config.id,
							)
					}
					const raw = yield* request(
						tool,
						connection,
						RenameRequest.type,
						{
							textDocument: { uri: document.uri },
							position,
							newName: input.newName,
						},
						timeoutMs,
					)
					const workspaceEdit = yield* decodeServerValue(
						tool,
						connection.config.id,
						'Invalid rename response',
						LspRenameResponse,
						raw,
					)
					const preview = yield* collectWorkspaceEdits(
						tool,
						connection.config.id,
						workspace,
						workspaceEdit ?? LspWorkspaceEdit.make({}),
					)
					const [firstUnsupported, ...remainingUnsupported] = preview.unsupportedChanges
					const base = {
						tool,
						server: connection.config.id,
						filePath: workspaceRelative(workspace, filePath),
						position,
						newName: input.newName,
						mode: 'preview' as const,
						applied: false as const,
						edits: preview.edits,
					}
					return firstUnsupported === undefined
						? LspCompleteRenameResult.make({ ...base, ok: true, unsupportedChanges: [] })
						: LspPartialRenameResult.make({
								...base,
								ok: false,
								unsupportedChanges: [firstUnsupported, ...remainingUnsupported],
							})
				}),
			),
	)
})

export const lspRename = Effect.fn(function* lspRename(input: LspRenameInput) {
	return yield* lspRenameOperation(input)
})
