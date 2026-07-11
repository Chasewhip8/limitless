import type { PluginInput } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin'
import { executeTool } from '../../core/tool-boundary'
import { lspToolFailureEncoder } from './errors'
import { LspReferencesInput, LspReferencesResult, lspReferences } from './references'
import { LspRenameInput, LspRenameResult, lspRename } from './rename'
import { LspSymbolsInput, LspSymbolsResult, lspSymbols } from './symbols'

const pathArgs = {
	workspace: tool.schema.string().optional(),
	filePath: tool.schema.string().optional(),
	path: tool.schema.string().optional(),
}

const positionArgs = {
	...pathArgs,
	server: tool.schema.string().optional(),
	timeoutMs: tool.schema.number().optional(),
	offset: tool.schema.number().optional(),
	line: tool.schema.number().optional(),
	character: tool.schema.number().optional(),
}

export function lspTools(pluginInput: PluginInput) {
	return {
		lsp_references: tool({
			description:
				'Find references through the configured language server for a zero-based file position.',
			args: {
				...positionArgs,
				includeDeclaration: tool.schema.boolean().optional(),
				maxResults: tool.schema.number().optional(),
			},
			execute: (args, context) =>
				executeTool(
					'lsp_references',
					LspReferencesInput,
					LspReferencesResult,
					args,
					context,
					(input) => lspReferences(pluginInput, input, context),
					lspToolFailureEncoder,
				),
		}),
		lsp_symbols: tool({
			description: 'Find document or workspace symbols through configured language servers.',
			args: {
				...pathArgs,
				server: tool.schema.string().optional(),
				timeoutMs: tool.schema.number().optional(),
				query: tool.schema.string().optional(),
				maxResults: tool.schema.number().optional(),
			},
			execute: (args, context) =>
				executeTool(
					'lsp_symbols',
					LspSymbolsInput,
					LspSymbolsResult,
					args,
					context,
					(input) => lspSymbols(pluginInput, input, context),
					lspToolFailureEncoder,
				),
		}),
		lsp_rename: tool({
			description:
				'Preview rename edits from the configured language server without writing files.',
			args: { ...positionArgs, newName: tool.schema.string() },
			execute: (args, context) =>
				executeTool(
					'lsp_rename',
					LspRenameInput,
					LspRenameResult,
					args,
					context,
					(input) => lspRename(pluginInput, input, context),
					lspToolFailureEncoder,
				),
		}),
	}
}
