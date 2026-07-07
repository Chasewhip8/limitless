import { Schema } from 'effect'

export type JsonRpcId = number | string

export type JsonRpcMessage = {
	readonly id?: unknown
	readonly method?: unknown
	readonly params?: unknown
	readonly result?: unknown
	readonly error?: unknown
}

export type PendingRequest = {
	readonly method: string
	readonly resolve: (value: unknown) => void
	readonly reject: (error: Error) => void
	readonly timeout: ReturnType<typeof setTimeout>
}

export type LspServerConfig = {
	readonly id: string
	readonly command: ReadonlyArray<string>
	readonly extensions: ReadonlyArray<string>
	readonly env: Readonly<Record<string, string>>
	readonly initialization: unknown
	readonly languageIds: Readonly<Record<string, string>>
}

export type LspDocument = {
	readonly uri: string
	readonly content: string
}

export type LspPosition = {
	readonly line: number
	readonly character: number
}

export type LspRange = {
	readonly start: LspPosition
	readonly end: LspPosition
}

export type LspLocation = {
	readonly uri: string
	readonly range: LspRange
}

export type LspLocationLink = {
	readonly targetUri: string
	readonly targetRange: LspRange
	readonly targetSelectionRange?: LspRange
}

export type NormalizedLocation = {
	readonly uri: string
	readonly filePath: string
	readonly range: LspRange
	readonly text?: string
}

export type NormalizedSymbol = {
	readonly name: string
	readonly kind?: number
	readonly detail?: string
	readonly filePath?: string
	readonly range?: LspRange
	readonly selectionRange?: LspRange
	readonly children?: ReadonlyArray<NormalizedSymbol>
}

export type NormalizedEdit = {
	readonly filePath: string
	readonly range: LspRange
	readonly newText: string
}

export type WorkspaceEditPreview = {
	readonly edits: ReadonlyArray<NormalizedEdit>
	readonly unsupportedChanges: ReadonlyArray<unknown>
}

export const LspReferencesInput = Schema.Struct({
	workspace: Schema.optional(Schema.String),
	filePath: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
	server: Schema.optional(Schema.String),
	timeoutMs: Schema.optional(Schema.Finite),
	maxResults: Schema.optional(Schema.Finite),
	offset: Schema.optional(Schema.Finite),
	line: Schema.optional(Schema.Finite),
	character: Schema.optional(Schema.Finite),
	includeDeclaration: Schema.optional(Schema.Boolean),
})
export type LspReferencesInput = typeof LspReferencesInput.Type

export const LspSymbolsInput = Schema.Struct({
	workspace: Schema.optional(Schema.String),
	filePath: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
	server: Schema.optional(Schema.String),
	timeoutMs: Schema.optional(Schema.Finite),
	query: Schema.optional(Schema.String),
	maxResults: Schema.optional(Schema.Finite),
})
export type LspSymbolsInput = typeof LspSymbolsInput.Type

export const LspRenameInput = Schema.Struct({
	workspace: Schema.optional(Schema.String),
	filePath: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
	server: Schema.optional(Schema.String),
	timeoutMs: Schema.optional(Schema.Finite),
	offset: Schema.optional(Schema.Finite),
	line: Schema.optional(Schema.Finite),
	character: Schema.optional(Schema.Finite),
	newName: Schema.String,
})
export type LspRenameInput = typeof LspRenameInput.Type
