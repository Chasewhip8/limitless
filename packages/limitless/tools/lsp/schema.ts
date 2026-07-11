import { Schema } from 'effect'

export const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
export type PositiveInteger = typeof PositiveInteger.Type

export const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export type NonNegativeInteger = typeof NonNegativeInteger.Type

export const LspStringRecord = Schema.Record(Schema.String, Schema.String)
export type LspStringRecord = typeof LspStringRecord.Type

export const JsonRpcId = Schema.Union([Schema.String, Schema.Int])
export type JsonRpcId = typeof JsonRpcId.Type

export const JsonRpcResponseId = Schema.Union([JsonRpcId, Schema.Null])
export type JsonRpcResponseId = typeof JsonRpcResponseId.Type

export const JsonRpcParams = Schema.Union([
	Schema.Record(Schema.String, Schema.Unknown),
	Schema.Array(Schema.Unknown),
])
export type JsonRpcParams = typeof JsonRpcParams.Type

export const JsonRpcErrorPayload = Schema.Struct({
	code: Schema.Int,
	message: Schema.String,
	data: Schema.optional(Schema.Unknown),
})
export type JsonRpcErrorPayload = typeof JsonRpcErrorPayload.Type

export const JsonRpcRequest = Schema.Struct({
	jsonrpc: Schema.Literal('2.0'),
	id: JsonRpcId,
	method: Schema.String,
	params: Schema.optional(JsonRpcParams),
})
export type JsonRpcRequest = typeof JsonRpcRequest.Type

export const JsonRpcNotification = Schema.Struct({
	jsonrpc: Schema.Literal('2.0'),
	method: Schema.String,
	params: Schema.optional(JsonRpcParams),
})
export type JsonRpcNotification = typeof JsonRpcNotification.Type

export const JsonRpcSuccessResponse = Schema.Struct({
	jsonrpc: Schema.Literal('2.0'),
	id: JsonRpcResponseId,
	result: Schema.Unknown,
})
export type JsonRpcSuccessResponse = typeof JsonRpcSuccessResponse.Type

export const JsonRpcErrorResponse = Schema.Struct({
	jsonrpc: Schema.Literal('2.0'),
	id: JsonRpcResponseId,
	error: JsonRpcErrorPayload,
})
export type JsonRpcErrorResponse = typeof JsonRpcErrorResponse.Type

export const JsonRpcIncomingMessage = Schema.Union([
	JsonRpcRequest,
	JsonRpcNotification,
	JsonRpcSuccessResponse,
	JsonRpcErrorResponse,
])
export type JsonRpcIncomingMessage = typeof JsonRpcIncomingMessage.Type

export const JsonRpcIncomingMessageFromJson = Schema.fromJsonString(JsonRpcIncomingMessage)

export const JsonRpcOutgoingMessage = Schema.Union([
	JsonRpcRequest,
	JsonRpcNotification,
	JsonRpcSuccessResponse,
	JsonRpcErrorResponse,
])
export type JsonRpcOutgoingMessage = typeof JsonRpcOutgoingMessage.Type
export const JsonRpcOutgoingMessageFromJson = Schema.fromJsonString(JsonRpcOutgoingMessage)

export const LspDocument = Schema.Struct({
	uri: Schema.String,
	content: Schema.String,
})
export type LspDocument = typeof LspDocument.Type

export const LspPosition = Schema.Struct({
	line: NonNegativeInteger,
	character: NonNegativeInteger,
})
export type LspPosition = typeof LspPosition.Type

export const LspRange = Schema.Struct({
	start: LspPosition,
	end: LspPosition,
})
export type LspRange = typeof LspRange.Type

export const LspLocation = Schema.Struct({
	uri: Schema.String,
	range: LspRange,
})
export type LspLocation = typeof LspLocation.Type

export const LspTextDocumentIdentifier = Schema.Struct({ uri: Schema.String })

export const LspTextDocumentPositionParams = Schema.Struct({
	textDocument: LspTextDocumentIdentifier,
	position: LspPosition,
})

export const LspDidOpenParams = Schema.Struct({
	textDocument: Schema.Struct({
		uri: Schema.String,
		languageId: Schema.String,
		version: PositiveInteger,
		text: Schema.String,
	}),
})

export const LspDidCloseParams = Schema.Struct({
	textDocument: LspTextDocumentIdentifier,
})

export const LspInitializeParams = Schema.Struct({
	processId: PositiveInteger,
	rootPath: Schema.String,
	rootUri: Schema.String,
	workspaceFolders: Schema.Array(
		Schema.Struct({
			uri: Schema.String,
			name: Schema.String,
		}),
	),
	capabilities: Schema.Struct({
		general: Schema.Struct({ positionEncodings: Schema.Array(Schema.String) }),
		workspace: Schema.Struct({
			workspaceFolders: Schema.Boolean,
			symbol: Schema.Struct({}),
		}),
		textDocument: Schema.Struct({
			documentSymbol: Schema.Struct({ hierarchicalDocumentSymbolSupport: Schema.Boolean }),
			references: Schema.Struct({}),
			rename: Schema.Struct({ prepareSupport: Schema.Boolean }),
			synchronization: Schema.Struct({ didSave: Schema.Boolean }),
		}),
	}),
	initializationOptions: Schema.optional(Schema.Unknown),
})

const LspProviderCapability = Schema.Union([
	Schema.Boolean,
	Schema.Record(Schema.String, Schema.Unknown),
])

export const LspRenameProviderCapability = Schema.Union([
	Schema.Boolean,
	Schema.Struct({ prepareProvider: Schema.optional(Schema.Boolean) }),
])
export type LspRenameProviderCapability = typeof LspRenameProviderCapability.Type

export const LspServerCapabilities = Schema.Struct({
	referencesProvider: Schema.optional(LspProviderCapability),
	documentSymbolProvider: Schema.optional(LspProviderCapability),
	workspaceSymbolProvider: Schema.optional(LspProviderCapability),
	renameProvider: Schema.optional(LspRenameProviderCapability),
})
export type LspServerCapabilities = typeof LspServerCapabilities.Type

export const LspCapabilityName = Schema.Union([
	Schema.Literal('referencesProvider'),
	Schema.Literal('documentSymbolProvider'),
	Schema.Literal('workspaceSymbolProvider'),
	Schema.Literal('renameProvider'),
])
export type LspCapabilityName = typeof LspCapabilityName.Type

export const LspInitializeResult = Schema.Struct({ capabilities: LspServerCapabilities })

export const LspWorkspaceConfigurationParams = Schema.Struct({
	items: Schema.Array(Schema.Unknown),
})

const PositionInputFields = {
	offset: Schema.optional(NonNegativeInteger),
	line: Schema.optional(NonNegativeInteger),
	character: Schema.optional(NonNegativeInteger),
}

export const LspPositionInput = Schema.Struct(PositionInputFields)
export type LspPositionInput = typeof LspPositionInput.Type

export const LspFileInput = Schema.Struct({
	filePath: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
})
export type LspFileInput = typeof LspFileInput.Type
