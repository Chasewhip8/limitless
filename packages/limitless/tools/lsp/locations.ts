import { fileURLToPath, pathToFileURL } from 'node:url'
import { Effect, Schema } from 'effect'
import { workspaceRelative } from '../../core/paths'
import { maybeLimit, readRangeText, uriToFilePath } from './connection'
import { LspLocation, LspRange } from './schema'

export const LspLocationLink = Schema.Struct({
	originSelectionRange: Schema.optional(LspRange),
	targetUri: Schema.String,
	targetRange: LspRange,
	targetSelectionRange: LspRange,
})
export type LspLocationLink = typeof LspLocationLink.Type

export const LspLocationResult = Schema.Union([LspLocation, LspLocationLink])
export type LspLocationResult = typeof LspLocationResult.Type

export const LspLocationArrayResponse = Schema.NullOr(Schema.Array(LspLocationResult))
export const LspLocationResponse = Schema.NullOr(
	Schema.Union([LspLocation, Schema.Array(LspLocation), Schema.Array(LspLocationLink)]),
)

export const NormalizedLocation = Schema.Struct({
	uri: Schema.String,
	filePath: Schema.String,
	range: LspRange,
	text: Schema.optional(Schema.String),
})
export type NormalizedLocation = typeof NormalizedLocation.Type

export function locationUri(value: LspLocationResult): string {
	return 'uri' in value ? value.uri : value.targetUri
}

export function locationRange(value: LspLocationResult): typeof LspRange.Type {
	return 'uri' in value ? value.range : value.targetSelectionRange
}

export function locationIdentity(value: LspLocationResult): string {
	const range = locationRange(value)
	const rawUri = locationUri(value)
	let uri = rawUri
	if (rawUri.startsWith('file:')) {
		try {
			uri = pathToFileURL(fileURLToPath(rawUri)).href
		} catch {
			// Invalid file URIs are rejected during normalization; keep identity calculation total.
		}
	}
	return JSON.stringify([
		uri,
		range.start.line,
		range.start.character,
		range.end.line,
		range.end.character,
	])
}

export function normalizedLocationIdentity(value: NormalizedLocation): string {
	return JSON.stringify([
		value.filePath,
		value.range.start.line,
		value.range.start.character,
		value.range.end.line,
		value.range.end.character,
	])
}

export function locationResponseItems(
	value: typeof LspLocationResponse.Type,
): ReadonlyArray<LspLocationResult> {
	if (value === null) return []
	return 'uri' in value ? [value] : value
}

export function deduplicateLocationResults(
	locations: ReadonlyArray<LspLocationResult>,
): ReadonlyArray<LspLocationResult> {
	const identities = new Set<string>()
	const unique: Array<LspLocationResult> = []
	for (const location of locations) {
		const identity = locationIdentity(location)
		if (identities.has(identity)) continue
		identities.add(identity)
		unique.push(location)
	}
	return unique
}

export const normalizeLocation = Effect.fn(function* normalizeLocation(
	tool: string,
	server: string,
	workspace: string,
	value: LspLocationResult,
) {
	const uri = locationUri(value)
	const range = locationRange(value)
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

export function normalizeLocations(
	tool: string,
	server: string,
	workspace: string,
	locations: ReadonlyArray<LspLocationResult>,
) {
	return Effect.forEach(locations, (location) =>
		normalizeLocation(tool, server, workspace, location),
	)
}

export const normalizeLocationResults = Effect.fn(function* normalizeLocationResults(
	tool: string,
	server: string,
	workspace: string,
	locations: ReadonlyArray<LspLocationResult>,
	maxResults: number | undefined,
) {
	const limited = maybeLimit(deduplicateLocationResults(locations), maxResults)
	return {
		locations: yield* normalizeLocations(tool, server, workspace, limited.items),
		truncated: limited.truncated,
	}
})
