import { Effect, Schema } from 'effect'
import { HoverRequest } from 'vscode-languageserver-protocol/node'
import { DEFAULT_TIMEOUT_MS } from '../../core/command'
import { ToolExecutionContext } from '../../core/execution'
import { workspaceRelative, workspaceRoot } from '../../core/paths'
import { loadServerConfigs } from './config'
import {
	request,
	requireCandidates,
	resolveFile,
	resolvePosition,
	runOnCapableServer,
	withDocument,
} from './connection'
import { decodeServerValue } from './errors'
import { LspPosition, LspRange, NonNegativeInteger, PositiveInteger } from './schema'

const LspMarkupContent = Schema.Struct({
	kind: Schema.Union([Schema.Literal('markdown'), Schema.Literal('plaintext')]),
	value: Schema.String,
})
const LspMarkedCode = Schema.Struct({ language: Schema.String, value: Schema.String })
const LspMarkedString = Schema.Union([Schema.String, LspMarkedCode])
const LspHoverResponse = Schema.NullOr(
	Schema.Struct({
		contents: Schema.Union([LspMarkupContent, LspMarkedString, Schema.Array(LspMarkedString)]),
		range: Schema.optional(LspRange),
	}),
)

export const LspHoverContent = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('markdown'), value: Schema.String }),
	Schema.Struct({ kind: Schema.Literal('plaintext'), value: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal('code'),
		language: Schema.String,
		value: Schema.String,
	}),
])
export type LspHoverContent = typeof LspHoverContent.Type

export const NormalizedHover = Schema.Struct({
	contents: Schema.Array(LspHoverContent),
	range: Schema.optional(LspRange),
})
export type NormalizedHover = typeof NormalizedHover.Type

export const LspHoverInput = Schema.Struct({
	workspace: Schema.optional(Schema.String),
	filePath: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
	server: Schema.optional(Schema.String),
	timeoutMs: Schema.optional(PositiveInteger),
	offset: Schema.optional(NonNegativeInteger),
	line: Schema.optional(NonNegativeInteger),
	character: Schema.optional(NonNegativeInteger),
})
export type LspHoverInput = typeof LspHoverInput.Type

export const LspHoverResult = Schema.Struct({
	ok: Schema.Literal(true),
	tool: Schema.Literal('lsp_hover'),
	server: Schema.String,
	filePath: Schema.String,
	position: LspPosition,
	hover: Schema.NullOr(NormalizedHover),
})
export type LspHoverResult = typeof LspHoverResult.Type

function normalizeMarkedString(value: typeof LspMarkedString.Type): LspHoverContent {
	return typeof value === 'string'
		? LspHoverContent.make({ kind: 'markdown', value })
		: LspHoverContent.make({ kind: 'code', language: value.language, value: value.value })
}

function normalizeHover(value: Exclude<typeof LspHoverResponse.Type, null>): NormalizedHover {
	const rawContents = value.contents
	let contents: Array<LspHoverContent>
	if (typeof rawContents === 'string') {
		contents = [normalizeMarkedString(rawContents)]
	} else if ('kind' in rawContents) {
		contents = [LspHoverContent.make({ kind: rawContents.kind, value: rawContents.value })]
	} else if ('language' in rawContents) {
		contents = [normalizeMarkedString(rawContents)]
	} else {
		contents = rawContents.map(normalizeMarkedString)
	}
	return NormalizedHover.make({
		contents,
		...(value.range === undefined ? {} : { range: value.range }),
	})
}

const lspHoverOperation = Effect.fn(function* lspHoverOperation(input: LspHoverInput) {
	const context = yield* ToolExecutionContext
	const tool = 'lsp_hover' as const
	const workspace = workspaceRoot(input, context.projectRoot)
	const filePath = yield* resolveFile(tool, workspace, input)
	const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const configs = yield* loadServerConfigs(tool)
	const candidates = yield* requireCandidates(tool, configs, filePath, input.server)
	return yield* runOnCapableServer(
		tool,
		workspace,
		candidates,
		'hoverProvider',
		timeoutMs,
		(connection) =>
			withDocument(tool, connection, filePath, timeoutMs, (document) =>
				Effect.gen(function* () {
					const position = yield* resolvePosition(tool, document.content, input)
					const raw = yield* request(
						tool,
						connection,
						HoverRequest.type,
						{ textDocument: { uri: document.uri }, position },
						timeoutMs,
					)
					const decoded = yield* decodeServerValue(
						tool,
						connection.config.id,
						'Invalid hover response',
						LspHoverResponse,
						raw,
					)
					return LspHoverResult.make({
						ok: true,
						tool,
						server: connection.config.id,
						filePath: workspaceRelative(workspace, filePath),
						position,
						hover: decoded === null ? null : normalizeHover(decoded),
					})
				}),
			),
	)
})

export const lspHover = Effect.fn(function* lspHover(input: LspHoverInput) {
	return yield* lspHoverOperation(input)
})
