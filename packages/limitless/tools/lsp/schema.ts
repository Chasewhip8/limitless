import { Schema } from 'effect'

export const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
export type PositiveInteger = typeof PositiveInteger.Type

export const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export type NonNegativeInteger = typeof NonNegativeInteger.Type

export const LspStringRecord = Schema.Record(Schema.String, Schema.String)
export type LspStringRecord = typeof LspStringRecord.Type

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
	definitionProvider: Schema.optional(LspProviderCapability),
	declarationProvider: Schema.optional(LspProviderCapability),
	typeDefinitionProvider: Schema.optional(LspProviderCapability),
	hoverProvider: Schema.optional(LspProviderCapability),
	implementationProvider: Schema.optional(LspProviderCapability),
	callHierarchyProvider: Schema.optional(LspProviderCapability),
	referencesProvider: Schema.optional(LspProviderCapability),
	documentSymbolProvider: Schema.optional(LspProviderCapability),
	workspaceSymbolProvider: Schema.optional(LspProviderCapability),
	renameProvider: Schema.optional(LspRenameProviderCapability),
})
export type LspServerCapabilities = typeof LspServerCapabilities.Type

export const LspCapabilityName = Schema.Union([
	Schema.Literal('definitionProvider'),
	Schema.Literal('declarationProvider'),
	Schema.Literal('typeDefinitionProvider'),
	Schema.Literal('hoverProvider'),
	Schema.Literal('implementationProvider'),
	Schema.Literal('callHierarchyProvider'),
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
