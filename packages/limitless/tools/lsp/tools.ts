import { defineLimitlessTool, type ToolExecutor } from '../../plugin/tool-boundary'
import { LspCallHierarchyInput, LspCallHierarchyResult, lspCallHierarchy } from './call-hierarchy'
import { LspDefinitionInput, LspDefinitionResult, lspDefinition } from './definition'
import { encodeLspToolFailure } from './errors'
import { LspHoverInput, LspHoverResult, lspHover } from './hover'
import {
	LspImplementationInput,
	LspImplementationResult,
	lspImplementation,
} from './implementation'
import { LspReferencesInput, LspReferencesResult, lspReferences } from './references'
import { LspRenameInput, LspRenameResult, lspRename } from './rename'
import { LspSymbolsInput, LspSymbolsResult, lspSymbols } from './symbols'

export function lspTools(executeTool: ToolExecutor) {
	return {
		lsp_definition: defineLimitlessTool({
			name: 'lsp_definition',
			description:
				'Find definitions, declarations, and type definitions supported by the configured language server.',
			input: LspDefinitionInput,
			output: LspDefinitionResult,
			execute: (input, context) =>
				executeTool('lsp_definition', input, context, lspDefinition, encodeLspToolFailure),
		}),
		lsp_hover: defineLimitlessTool({
			name: 'lsp_hover',
			description: 'Show normalized hover information at a zero-based file position.',
			input: LspHoverInput,
			output: LspHoverResult,
			execute: (input, context) =>
				executeTool('lsp_hover', input, context, lspHover, encodeLspToolFailure),
		}),
		lsp_implementation: defineLimitlessTool({
			name: 'lsp_implementation',
			description: 'Find implementations through the configured language server.',
			input: LspImplementationInput,
			output: LspImplementationResult,
			execute: (input, context) =>
				executeTool('lsp_implementation', input, context, lspImplementation, encodeLspToolFailure),
		}),
		lsp_call_hierarchy: defineLimitlessTool({
			name: 'lsp_call_hierarchy',
			description:
				'Find incoming and outgoing calls for every prepared call hierarchy item at a file position.',
			input: LspCallHierarchyInput,
			output: LspCallHierarchyResult,
			execute: (input, context) =>
				executeTool('lsp_call_hierarchy', input, context, lspCallHierarchy, encodeLspToolFailure),
		}),
		lsp_references: defineLimitlessTool({
			name: 'lsp_references',
			description:
				'Find references through the configured language server for a zero-based file position.',
			input: LspReferencesInput,
			output: LspReferencesResult,
			execute: (input, context) =>
				executeTool('lsp_references', input, context, lspReferences, encodeLspToolFailure),
		}),
		lsp_symbols: defineLimitlessTool({
			name: 'lsp_symbols',
			description: 'Find document or workspace symbols through configured language servers.',
			input: LspSymbolsInput,
			output: LspSymbolsResult,
			execute: (input, context) =>
				executeTool('lsp_symbols', input, context, lspSymbols, encodeLspToolFailure),
		}),
		lsp_rename: defineLimitlessTool({
			name: 'lsp_rename',
			description:
				'Preview rename edits from the configured language server without writing files.',
			input: LspRenameInput,
			output: LspRenameResult,
			execute: (input, context) =>
				executeTool('lsp_rename', input, context, lspRename, encodeLspToolFailure),
		}),
	}
}
