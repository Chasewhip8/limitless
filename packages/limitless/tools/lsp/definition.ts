import { Effect, Ref, Result, Schema } from 'effect'
import {
	DeclarationRequest,
	DefinitionRequest,
	TypeDefinitionRequest,
} from 'vscode-languageserver-protocol/node'
import { DEFAULT_TIMEOUT_MS } from '../../core/command'
import { ToolExecutionContext } from '../../core/execution'
import { workspaceRelative, workspaceRoot } from '../../core/paths'
import { loadServerConfigs } from './config'
import {
	connectionResource,
	maybeLimit,
	request,
	requireCandidates,
	resolveFile,
	resolvePosition,
	supportsCapability,
	withDocument,
	withOperationDeadline,
} from './connection'
import { decodeServerValue, lspError } from './errors'
import {
	LspLocationResponse,
	locationResponseItems,
	NormalizedLocation,
	normalizedLocationIdentity,
	normalizeLocations,
} from './locations'
import type { LspConnectionRuntime } from './runtime'
import { LspPosition, NonNegativeInteger, PositiveInteger } from './schema'

export const LspDefinitionRelationship = Schema.Union([
	Schema.Literal('definition'),
	Schema.Literal('declaration'),
	Schema.Literal('typeDefinition'),
])
export type LspDefinitionRelationship = typeof LspDefinitionRelationship.Type

export const LspDefinitionLocation = Schema.Struct({
	...NormalizedLocation.fields,
	relationships: Schema.NonEmptyArray(LspDefinitionRelationship),
})
export type LspDefinitionLocation = typeof LspDefinitionLocation.Type

export const LspDefinitionRelationshipError = Schema.Struct({
	relationship: LspDefinitionRelationship,
	message: Schema.String,
})
export type LspDefinitionRelationshipError = typeof LspDefinitionRelationshipError.Type

export const LspDefinitionInput = Schema.Struct({
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
export type LspDefinitionInput = typeof LspDefinitionInput.Type

export const LspDefinitionResult = Schema.Struct({
	ok: Schema.Literal(true),
	tool: Schema.Literal('lsp_definition'),
	server: Schema.String,
	filePath: Schema.String,
	position: LspPosition,
	locations: Schema.Array(LspDefinitionLocation),
	unsupportedRelationships: Schema.Array(LspDefinitionRelationship),
	errors: Schema.Array(LspDefinitionRelationshipError),
	truncated: Schema.Boolean,
})
export type LspDefinitionResult = typeof LspDefinitionResult.Type

const definitionRelationships = [
	{ relationship: 'definition' as const, capability: 'definitionProvider' as const },
	{ relationship: 'declaration' as const, capability: 'declarationProvider' as const },
	{ relationship: 'typeDefinition' as const, capability: 'typeDefinitionProvider' as const },
]

function requestRelationship(
	tool: string,
	connection: LspConnectionRuntime,
	relationship: LspDefinitionRelationship,
	uri: string,
	position: typeof LspPosition.Type,
	timeoutMs: number,
) {
	const params = { textDocument: { uri }, position }
	if (relationship === 'definition')
		return request(tool, connection, DefinitionRequest.type, params, timeoutMs)
	if (relationship === 'declaration')
		return request(tool, connection, DeclarationRequest.type, params, timeoutMs)
	return request(tool, connection, TypeDefinitionRequest.type, params, timeoutMs)
}

const lspDefinitionOperation = Effect.fn(function* lspDefinitionOperation(
	input: LspDefinitionInput,
) {
	const context = yield* ToolExecutionContext
	const tool = 'lsp_definition' as const
	const workspace = workspaceRoot(input, context.projectRoot)
	const filePath = yield* resolveFile(tool, workspace, input)
	const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const configs = yield* loadServerConfigs(tool)
	const candidates = yield* requireCandidates(tool, configs, filePath, input.server)
	const candidateErrors: Array<string> = []
	let anySupported = false

	for (const config of candidates) {
		const result = yield* Effect.result(
			Effect.scoped(
				Effect.gen(function* () {
					const connection = yield* connectionResource(tool, config, workspace, timeoutMs)
					const capabilities = yield* Ref.get(connection.capabilities)
					const supported = definitionRelationships.filter(({ capability }) =>
						supportsCapability(capabilities, capability),
					)
					if (supported.length === 0) return undefined
					anySupported = true
					return yield* withDocument(tool, connection, filePath, timeoutMs, (document) =>
						Effect.gen(function* () {
							const position = yield* resolvePosition(tool, document.content, input)
							return yield* withOperationDeadline(
								tool,
								connection,
								'Definition relationships',
								timeoutMs,
								Effect.gen(function* () {
									const normalizedLocations: Array<NormalizedLocation> = []
									const relationshipsByLocation: Array<Array<LspDefinitionRelationship>> = []
									const locationIndexes = new Map<string, number>()
									const errors: Array<LspDefinitionRelationshipError> = []
									let succeeded = 0

									for (const { relationship } of supported) {
										const response = yield* Effect.result(
											requestRelationship(
												tool,
												connection,
												relationship,
												document.uri,
												position,
												timeoutMs,
											).pipe(
												Effect.flatMap((raw) =>
													decodeServerValue(
														tool,
														connection.config.id,
														`Invalid ${relationship} response`,
														LspLocationResponse,
														raw,
													),
												),
												Effect.flatMap((decoded) =>
													normalizeLocations(
														tool,
														connection.config.id,
														workspace,
														locationResponseItems(decoded),
													),
												),
											),
										)
										if (Result.isFailure(response)) {
											errors.push(
												LspDefinitionRelationshipError.make({
													relationship,
													message: response.failure.message,
												}),
											)
											continue
										}
										succeeded += 1
										for (const location of response.success) {
											const identity = normalizedLocationIdentity(location)
											const existingIndex = locationIndexes.get(identity)
											if (existingIndex === undefined) {
												locationIndexes.set(identity, normalizedLocations.length)
												normalizedLocations.push(location)
												relationshipsByLocation.push([relationship])
												continue
											}
											const relationships = relationshipsByLocation[existingIndex]
											if (relationships !== undefined && !relationships.includes(relationship))
												relationships.push(relationship)
										}
									}

									if (succeeded === 0) {
										return yield* lspError(
											tool,
											`Every supported definition relationship failed. ${errors.map((error) => `${error.relationship}: ${error.message}`).join('; ')}`,
											connection.config.id,
										)
									}

									const limited = maybeLimit(normalizedLocations, input.maxResults)
									const locations: Array<LspDefinitionLocation> = []
									for (const [index, location] of limited.items.entries()) {
										const relationships = relationshipsByLocation[index] ?? []
										const [firstRelationship, ...remainingRelationships] = relationships
										if (firstRelationship === undefined)
											return yield* lspError(
												tool,
												'Aggregated definition location has no relationship.',
												connection.config.id,
											)
										locations.push(
											LspDefinitionLocation.make({
												...location,
												relationships: [firstRelationship, ...remainingRelationships],
											}),
										)
									}

									return LspDefinitionResult.make({
										ok: true,
										tool,
										server: connection.config.id,
										filePath: workspaceRelative(workspace, filePath),
										position,
										locations,
										unsupportedRelationships: definitionRelationships.flatMap(
											({ relationship, capability }) =>
												supportsCapability(capabilities, capability) ? [] : [relationship],
										),
										errors,
										truncated: limited.truncated,
									})
								}),
							)
						}),
					)
				}),
			),
		)
		if (Result.isSuccess(result) && result.success !== undefined) return result.success
		if (Result.isFailure(result)) candidateErrors.push(`${config.id}: ${result.failure.message}`)
		else candidateErrors.push(`${config.id}: no supported definition relationships`)
	}

	return yield* lspError(
		tool,
		anySupported
			? `Every attempted definition relationship failed. ${candidateErrors.join('; ')}`
			: `No candidate LSP server supports definition, declaration, or typeDefinition. ${candidateErrors.join('; ')}`,
		candidates.length === 1 ? candidates[0]?.id : undefined,
	)
})

export const lspDefinition = Effect.fn(function* lspDefinition(input: LspDefinitionInput) {
	return yield* lspDefinitionOperation(input)
})
