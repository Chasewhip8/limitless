import { Tool } from '@opencode-ai/plugin/v2/effect/tool'
import { type ToolExecutor, toolModelOutput } from '../../plugin/tool-boundary'
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
		lsp_definition: Tool.make({
			description:
				'Find definitions, declarations, and type definitions supported by the configured language server.',
			input: LspDefinitionInput,
			output: LspDefinitionResult,
			toModelOutput: toolModelOutput,
			execute: (input, context) =>
				executeTool('lsp_definition', input, context, lspDefinition, encodeLspToolFailure),
		}),
		lsp_hover: Tool.make({
			description: 'Show normalized hover information at a zero-based file position.',
			input: LspHoverInput,
			output: LspHoverResult,
			toModelOutput: toolModelOutput,
			execute: (input, context) =>
				executeTool('lsp_hover', input, context, lspHover, encodeLspToolFailure),
		}),
		lsp_implementation: Tool.make({
			description: 'Find implementations through the configured language server.',
			input: LspImplementationInput,
			output: LspImplementationResult,
			toModelOutput: toolModelOutput,
			execute: (input, context) =>
				executeTool('lsp_implementation', input, context, lspImplementation, encodeLspToolFailure),
		}),
		lsp_call_hierarchy: Tool.make({
			description:
				'Find incoming and outgoing calls for every prepared call hierarchy item at a file position.',
			input: LspCallHierarchyInput,
			output: LspCallHierarchyResult,
			toModelOutput: toolModelOutput,
			execute: (input, context) =>
				executeTool('lsp_call_hierarchy', input, context, lspCallHierarchy, encodeLspToolFailure),
		}),
		lsp_references: Tool.make({
			description:
				'Find references through the configured language server for a zero-based file position.',
			input: LspReferencesInput,
			output: LspReferencesResult,
			toModelOutput: toolModelOutput,
			execute: (input, context) =>
				executeTool('lsp_references', input, context, lspReferences, encodeLspToolFailure),
		}),
		lsp_symbols: Tool.make({
			description: 'Find document or workspace symbols through configured language servers.',
			input: LspSymbolsInput,
			output: LspSymbolsResult,
			toModelOutput: toolModelOutput,
			execute: (input, context) =>
				executeTool('lsp_symbols', input, context, lspSymbols, encodeLspToolFailure),
		}),
		lsp_rename: Tool.make({
			description:
				'Preview rename edits from the configured language server without writing files.',
			input: LspRenameInput,
			output: LspRenameResult,
			toModelOutput: toolModelOutput,
			execute: (input, context) =>
				executeTool('lsp_rename', input, context, lspRename, encodeLspToolFailure),
		}),
	}
}
