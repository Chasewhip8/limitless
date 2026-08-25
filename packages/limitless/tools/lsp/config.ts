import path from 'node:path'
import { Context, Effect, Option, Schema } from 'effect'
import { TrimmedNonEmptyString } from '../../core/command'
import { schemaErrorMessage } from '../../lib/guards'
import { lspError } from './errors'
import { LspStringRecord } from './schema'

export const DisabledLspServerConfig = Schema.Struct({ disabled: Schema.Literal(true) })
export const ConfiguredLspServer = Schema.Struct({
	command: Schema.NonEmptyArray(TrimmedNonEmptyString),
	extensions: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
	env: Schema.optional(LspStringRecord),
	initialization: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
	languageIds: Schema.optional(LspStringRecord),
	disabled: Schema.optional(Schema.Boolean),
})
export const LimitlessLspPluginOptions = Schema.Struct({
	lsp: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
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

export class LspConfigError extends Schema.TaggedError<LspConfigError>()('LspConfigError', {
	message: Schema.String,
}) {}

export type LspConfig = {
	readonly servers: ReadonlyArray<LspServerConfig>
}

export const LspConfig = Context.Service<LspConfig>('@limitless/lsp/LspConfig')

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

const normalizeServerConfig = Effect.fn('normalizeServerConfig')(function* (
	id: string,
	raw: unknown,
) {
	if (Option.isSome(Schema.decodeUnknownOption(DisabledLspServerConfig)(raw))) return undefined
	const configured = yield* Schema.decodeUnknownEffect(ConfiguredLspServer)(raw).pipe(
		Effect.mapError(
			(error) =>
				new LspConfigError({
					message: `Invalid Limitless LSP plugin option for ${id}: ${schemaErrorMessage(error)}`,
				}),
		),
	)
	if (configured.disabled === true) return undefined
	return LspServerConfig.make({
		id,
		command: configured.command,
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
	})
})

export const decodeLspConfig = Effect.fn('decodeLspConfig')(function* (options: unknown) {
	const decoded = yield* Schema.decodeUnknownEffect(LimitlessLspPluginOptions)(options).pipe(
		Effect.mapError(
			(error) =>
				new LspConfigError({
					message: `Invalid Limitless plugin options: ${schemaErrorMessage(error)}`,
				}),
		),
	)
	const servers = yield* Effect.forEach(Object.entries(decoded.lsp ?? {}), ([id, raw]) =>
		normalizeServerConfig(id, raw),
	)
	return LspConfig.of({ servers: servers.filter((server) => server !== undefined) })
})

export const loadServerConfigs = Effect.fn('loadServerConfigs')(function* (tool: string) {
	const config = yield* LspConfig
	if (config.servers.length === 0)
		return yield* lspError(tool, 'No LSP servers are configured in Limitless plugin options.')
	return config.servers
})

export function pathExtension(filePath: string): string {
	if (path.basename(filePath).toLowerCase() === 'flake.lock') return '.json'
	return path.extname(filePath).toLowerCase()
}

export function matchingServers(
	servers: ReadonlyArray<LspServerConfig>,
	filePath: string | undefined,
	serverId: string | undefined,
): ReadonlyArray<LspServerConfig> {
	if (serverId !== undefined) return servers.filter((server) => server.id === serverId)
	if (filePath === undefined) return []
	const extension = pathExtension(filePath)
	return servers.filter((server) => server.extensions.includes(extension))
}

export function languageId(filePath: string, config: LspServerConfig): string {
	const extension = pathExtension(filePath)
	return (
		(config.languageIds[extension] ?? builtInLanguageIds[extension] ?? extension.slice(1)) ||
		config.id
	)
}
