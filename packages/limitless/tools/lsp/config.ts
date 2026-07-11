import path from 'node:path'
import type { PluginInput } from '@opencode-ai/plugin'
import { Effect, Option, Schema } from 'effect'
import { TrimmedNonEmptyString } from '../../core/command'
import { describeUnknown, schemaErrorMessage } from '../../lib/guards'
import { decodeServerValue, lspError } from './errors'
import { LspStringRecord } from './schema'

export const OpenCodeLspConfig = Schema.Struct({
	lsp: Schema.optional(
		Schema.Union([Schema.Boolean, Schema.Record(Schema.String, Schema.Unknown)]),
	),
})
export const DisabledLspServerConfig = Schema.Struct({ disabled: Schema.Literal(true) })
export const ConfiguredLspServer = Schema.Struct({
	command: Schema.Union([TrimmedNonEmptyString, Schema.NonEmptyArray(TrimmedNonEmptyString)]),
	args: Schema.optional(Schema.Array(Schema.String)),
	extensions: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
	env: Schema.optional(LspStringRecord),
	initialization: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
	languageIds: Schema.optional(LspStringRecord),
	disabled: Schema.optional(Schema.Boolean),
})
export const LspServerConfig = Schema.Struct({
	id: TrimmedNonEmptyString,
	command: Schema.NonEmptyArray(TrimmedNonEmptyString),
	extensions: Schema.Array(TrimmedNonEmptyString),
	env: LspStringRecord,
	initialization: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
	languageIds: LspStringRecord,
})
export type LspServerConfig = typeof LspServerConfig.Type
type LspServerConfigType = typeof LspServerConfig.Type

const builtInLanguageIds = LspStringRecord.make({
	'.cjs': 'javascript',
	'.cts': 'typescript',
	'.js': 'javascript',
	'.c': 'c',
	'.cc': 'cpp',
	'.cpp': 'cpp',
	'.cs': 'csharp',
	'.json': 'json',
	'.jsonc': 'json',
	'.go': 'go',
	'.h': 'c',
	'.hpp': 'cpp',
	'.java': 'java',
	'.jsx': 'javascriptreact',
	'.kt': 'kotlin',
	'.kts': 'kotlin',
	'.lua': 'lua',
	'.markdown': 'markdown',
	'.md': 'markdown',
	'.mjs': 'javascript',
	'.mts': 'typescript',
	'.nix': 'nix',
	'.php': 'php',
	'.py': 'python',
	'.rb': 'ruby',
	'.rs': 'rust',
	'.sh': 'shellscript',
	'.swift': 'swift',
	'.toml': 'toml',
	'.ts': 'typescript',
	'.tsx': 'typescriptreact',
	'.yaml': 'yaml',
	'.yml': 'yaml',
})

function normalizeExtension(extension: string): string {
	return extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`
}

const normalizeServerConfig = Effect.fn(function* normalizeServerConfig(
	tool: string,
	id: string,
	raw: unknown,
) {
	if (Option.isSome(Schema.decodeUnknownOption(DisabledLspServerConfig)(raw))) return undefined
	const configured = yield* decodeServerValue(
		tool,
		id,
		`Invalid OpenCode LSP configuration for server ${id}`,
		ConfiguredLspServer,
		raw,
	)
	if (configured.disabled === true) return undefined
	const command =
		typeof configured.command === 'string'
			? [configured.command, ...(configured.args ?? [])]
			: configured.command
	return yield* decodeServerValue(
		tool,
		id,
		`Invalid normalized LSP configuration for server ${id}`,
		LspServerConfig,
		{
			id,
			command,
			extensions: (configured.extensions ?? []).map(normalizeExtension),
			env: configured.env ?? {},
			...(configured.initialization === undefined
				? {}
				: { initialization: configured.initialization }),
			languageIds: Object.fromEntries(
				Object.entries(configured.languageIds ?? {}).map(([extension, language]) => [
					normalizeExtension(extension),
					language,
				]),
			),
		},
	)
})

export const loadServerConfigs = Effect.fn(function* loadServerConfigs(
	input: PluginInput,
	tool: string,
	workspace: string,
) {
	const result = yield* Effect.tryPromise({
		try: () => input.client.config.get({ query: { directory: workspace } }),
		catch: (error) => lspError(tool, `Unable to read OpenCode config: ${describeUnknown(error)}`),
	})
	const config = yield* Schema.decodeUnknownEffect(OpenCodeLspConfig)(result.data).pipe(
		Effect.mapError((error) =>
			lspError(tool, `Invalid OpenCode LSP config: ${schemaErrorMessage(error)}`),
		),
	)
	const servers: Array<LspServerConfigType> = []
	const configuredServers = typeof config.lsp === 'object' && config.lsp !== null ? config.lsp : {}
	for (const [id, raw] of Object.entries(configuredServers)) {
		const server = yield* normalizeServerConfig(tool, id, raw)
		if (server !== undefined) servers.push(server)
	}
	if (servers.length === 0)
		return yield* lspError(tool, 'No LSP servers are configured in OpenCode config.')
	return servers
})

export function pathExtension(filePath: string): string {
	if (path.basename(filePath).toLowerCase() === 'flake.lock') return '.json'
	return path.extname(filePath).toLowerCase()
}

export function matchingServers(
	servers: ReadonlyArray<LspServerConfigType>,
	filePath: string | undefined,
	serverId: string | undefined,
): ReadonlyArray<LspServerConfigType> {
	if (serverId !== undefined) return servers.filter((server) => server.id === serverId)
	if (filePath === undefined) return []
	const extension = pathExtension(filePath)
	return servers.filter((server) => server.extensions.includes(extension))
}

export function languageId(filePath: string, config: LspServerConfigType): string {
	const extension = pathExtension(filePath)
	return (
		(config.languageIds[extension] ?? builtInLanguageIds[extension] ?? extension.slice(1)) ||
		config.id
	)
}
