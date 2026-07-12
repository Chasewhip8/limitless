import type { PluginInput, ToolContext } from '@opencode-ai/plugin'
import { Effect, Result, Schema } from 'effect'
import {
	CallHierarchyIncomingCallsRequest,
	type CallHierarchyItem,
	CallHierarchyOutgoingCallsRequest,
	CallHierarchyPrepareRequest,
} from 'vscode-languageserver-protocol/node'
import { DEFAULT_TIMEOUT_MS } from '../../core/command'
import { workspaceRelative, workspaceRoot } from '../../core/paths'
import { loadServerConfigs } from './config'
import {
	request,
	requireCandidates,
	resolveFile,
	resolvePosition,
	runOnCapableServer,
	uriToFilePath,
	withCancellation,
	withDocument,
	withOperationDeadline,
} from './connection'
import { decodeServerValue, lspError } from './errors'
import type { LspConnectionRuntime } from './runtime'
import { LspPosition, LspRange, NonNegativeInteger, PositiveInteger } from './schema'

const LspCallHierarchyItem = Schema.Struct({
	name: Schema.String,
	kind: PositiveInteger,
	tags: Schema.optional(Schema.Array(PositiveInteger)),
	detail: Schema.optional(Schema.String),
	uri: Schema.String,
	range: LspRange,
	selectionRange: LspRange,
	data: Schema.optional(Schema.Unknown),
})
const LspCallHierarchyPrepareResponse = Schema.NullOr(Schema.Array(LspCallHierarchyItem))
const LspCallHierarchyIncomingCall = Schema.Struct({
	from: LspCallHierarchyItem,
	fromRanges: Schema.Array(LspRange),
})
const LspCallHierarchyOutgoingCall = Schema.Struct({
	to: LspCallHierarchyItem,
	fromRanges: Schema.Array(LspRange),
})
const LspCallHierarchyIncomingResponse = Schema.NullOr(Schema.Array(LspCallHierarchyIncomingCall))
const LspCallHierarchyOutgoingResponse = Schema.NullOr(Schema.Array(LspCallHierarchyOutgoingCall))

export const NormalizedCallHierarchyItem = Schema.Struct({
	name: Schema.String,
	kind: PositiveInteger,
	tags: Schema.optional(Schema.Array(PositiveInteger)),
	detail: Schema.optional(Schema.String),
	uri: Schema.String,
	filePath: Schema.String,
	range: LspRange,
	selectionRange: LspRange,
})
export type NormalizedCallHierarchyItem = typeof NormalizedCallHierarchyItem.Type

export const LspIncomingCall = Schema.Struct({
	from: NormalizedCallHierarchyItem,
	fromRanges: Schema.Array(LspRange),
})
export type LspIncomingCall = typeof LspIncomingCall.Type

export const LspOutgoingCall = Schema.Struct({
	to: NormalizedCallHierarchyItem,
	fromRanges: Schema.Array(LspRange),
})
export type LspOutgoingCall = typeof LspOutgoingCall.Type

export const LspCallHierarchyDirectionError = Schema.Struct({
	direction: Schema.Union([Schema.Literal('incoming'), Schema.Literal('outgoing')]),
	message: Schema.String,
})
export type LspCallHierarchyDirectionError = typeof LspCallHierarchyDirectionError.Type

export const LspPreparedCallHierarchy = Schema.Struct({
	item: NormalizedCallHierarchyItem,
	incomingCalls: Schema.Array(LspIncomingCall),
	outgoingCalls: Schema.Array(LspOutgoingCall),
	errors: Schema.Array(LspCallHierarchyDirectionError),
	truncated: Schema.Boolean,
})
export type LspPreparedCallHierarchy = typeof LspPreparedCallHierarchy.Type

export const LspCallHierarchyInput = Schema.Struct({
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
export type LspCallHierarchyInput = typeof LspCallHierarchyInput.Type

export const LspCallHierarchyResult = Schema.Struct({
	ok: Schema.Literal(true),
	tool: Schema.Literal('lsp_call_hierarchy'),
	server: Schema.String,
	filePath: Schema.String,
	position: LspPosition,
	prepareStatus: Schema.Union([
		Schema.Literal('items'),
		Schema.Literal('empty'),
		Schema.Literal('null'),
	]),
	preparedItems: Schema.Array(LspPreparedCallHierarchy),
	truncated: Schema.Boolean,
})
export type LspCallHierarchyResult = typeof LspCallHierarchyResult.Type

const normalizeCallHierarchyItem = Effect.fn(function* normalizeCallHierarchyItem(
	tool: string,
	server: string,
	workspace: string,
	item: typeof LspCallHierarchyItem.Type,
) {
	const absolutePath = yield* uriToFilePath(tool, server, item.uri)
	return NormalizedCallHierarchyItem.make({
		name: item.name,
		kind: item.kind,
		...(item.tags === undefined ? {} : { tags: item.tags }),
		...(item.detail === undefined ? {} : { detail: item.detail }),
		uri: item.uri,
		filePath: absolutePath === undefined ? item.uri : workspaceRelative(workspace, absolutePath),
		range: item.range,
		selectionRange: item.selectionRange,
	})
})

const queryIncomingCalls = Effect.fn(function* queryIncomingCalls(
	tool: string,
	connection: LspConnectionRuntime,
	workspace: string,
	item: CallHierarchyItem,
	timeoutMs: number,
) {
	const raw = yield* request(
		tool,
		connection,
		CallHierarchyIncomingCallsRequest.type,
		{ item },
		timeoutMs,
	)
	const decoded = yield* decodeServerValue(
		tool,
		connection.config.id,
		'Invalid incoming call hierarchy response',
		LspCallHierarchyIncomingResponse,
		raw,
	)
	return yield* Effect.forEach(decoded ?? [], (call) =>
		normalizeCallHierarchyItem(tool, connection.config.id, workspace, call.from).pipe(
			Effect.map((from) => LspIncomingCall.make({ from, fromRanges: call.fromRanges })),
		),
	)
})

const queryOutgoingCalls = Effect.fn(function* queryOutgoingCalls(
	tool: string,
	connection: LspConnectionRuntime,
	workspace: string,
	item: CallHierarchyItem,
	timeoutMs: number,
) {
	const raw = yield* request(
		tool,
		connection,
		CallHierarchyOutgoingCallsRequest.type,
		{ item },
		timeoutMs,
	)
	const decoded = yield* decodeServerValue(
		tool,
		connection.config.id,
		'Invalid outgoing call hierarchy response',
		LspCallHierarchyOutgoingResponse,
		raw,
	)
	return yield* Effect.forEach(decoded ?? [], (call) =>
		normalizeCallHierarchyItem(tool, connection.config.id, workspace, call.to).pipe(
			Effect.map((to) => LspOutgoingCall.make({ to, fromRanges: call.fromRanges })),
		),
	)
})

const lspCallHierarchyOperation = Effect.fn(function* lspCallHierarchyOperation(
	pluginInput: PluginInput,
	input: LspCallHierarchyInput,
	context: ToolContext,
) {
	const tool = 'lsp_call_hierarchy' as const
	const workspace = workspaceRoot(input, context)
	const filePath = yield* resolveFile(tool, workspace, input)
	const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const configs = yield* loadServerConfigs(pluginInput, tool, workspace)
	const candidates = yield* requireCandidates(tool, configs, filePath, input.server)
	return yield* runOnCapableServer(
		tool,
		workspace,
		candidates,
		'callHierarchyProvider',
		timeoutMs,
		(connection) =>
			withDocument(tool, connection, filePath, timeoutMs, (document) =>
				Effect.gen(function* () {
					const position = yield* resolvePosition(tool, document.content, input)
					return yield* withOperationDeadline(
						tool,
						connection,
						'Call hierarchy requests',
						timeoutMs,
						Effect.gen(function* () {
							const rawPrepare = yield* request(
								tool,
								connection,
								CallHierarchyPrepareRequest.type,
								{ textDocument: { uri: document.uri }, position },
								timeoutMs,
							)
							const prepared = yield* decodeServerValue(
								tool,
								connection.config.id,
								'Invalid prepare call hierarchy response',
								LspCallHierarchyPrepareResponse,
								rawPrepare,
							)
							const prepareStatus =
								prepared === null
									? ('null' as const)
									: prepared.length === 0
										? ('empty' as const)
										: ('items' as const)
							const decodedItems = prepared ?? []
							// Servers may attach opaque fields beyond `data`; follow-up requests need the wire item intact.
							const rawItems = rawPrepare ?? []
							const preparedItems: Array<LspPreparedCallHierarchy> = []
							let remaining = input.maxResults
							let truncated = false

							for (const [index, decodedItem] of decodedItems.entries()) {
								const rawItem = rawItems[index]
								if (rawItem === undefined)
									return yield* lspError(
										tool,
										'Validated call hierarchy preparation did not preserve every raw item.',
										connection.config.id,
									)
								const incoming = yield* Effect.result(
									queryIncomingCalls(tool, connection, workspace, rawItem, timeoutMs),
								)
								const outgoing = yield* Effect.result(
									queryOutgoingCalls(tool, connection, workspace, rawItem, timeoutMs),
								)
								const errors: Array<LspCallHierarchyDirectionError> = []
								const allIncoming = Result.isSuccess(incoming) ? incoming.success : []
								const allOutgoing = Result.isSuccess(outgoing) ? outgoing.success : []
								if (Result.isFailure(incoming))
									errors.push(
										LspCallHierarchyDirectionError.make({
											direction: 'incoming',
											message: incoming.failure.message,
										}),
									)
								if (Result.isFailure(outgoing))
									errors.push(
										LspCallHierarchyDirectionError.make({
											direction: 'outgoing',
											message: outgoing.failure.message,
										}),
									)

								const incomingCalls =
									remaining === undefined ? allIncoming : allIncoming.slice(0, remaining)
								if (remaining !== undefined)
									remaining = Math.max(0, remaining - incomingCalls.length)
								const outgoingCalls =
									remaining === undefined ? allOutgoing : allOutgoing.slice(0, remaining)
								if (remaining !== undefined)
									remaining = Math.max(0, remaining - outgoingCalls.length)
								const itemTruncated =
									incomingCalls.length < allIncoming.length ||
									outgoingCalls.length < allOutgoing.length
								truncated ||= itemTruncated
								preparedItems.push(
									LspPreparedCallHierarchy.make({
										item: yield* normalizeCallHierarchyItem(
											tool,
											connection.config.id,
											workspace,
											decodedItem,
										),
										incomingCalls,
										outgoingCalls,
										errors,
										truncated: itemTruncated,
									}),
								)
							}

							return LspCallHierarchyResult.make({
								ok: true,
								tool,
								server: connection.config.id,
								filePath: workspaceRelative(workspace, filePath),
								position,
								prepareStatus,
								preparedItems,
								truncated,
							})
						}),
					)
				}),
			),
	)
})

export const lspCallHierarchy = Effect.fn(function* lspCallHierarchy(
	pluginInput: PluginInput,
	input: LspCallHierarchyInput,
	context: ToolContext,
) {
	return yield* withCancellation(
		'lsp_call_hierarchy',
		context.abort,
		lspCallHierarchyOperation(pluginInput, input, context),
	)
})
