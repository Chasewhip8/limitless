import { type Plugin, type PluginOptions, tool } from '@opencode-ai/plugin'
import { artifactCreate, artifactList } from './artifacts'
import { astGrepReplace, astGrepSearch } from './astgrep'
import { lspDiagnostics } from './diagnostics'
import {
	githubCodeSearch,
	githubFileRead,
	githubRepoTree,
	normalizeGitHubPluginConfig,
} from './github'
import { ArtifactCreateInput, ArtifactListInput } from './lib/artifact'
import { AstGrepReplaceInput, AstGrepSearchInput } from './lib/astgrep'
import { DiagnosticsInput } from './lib/diagnostics'
import { GitHubCodeSearchInput, GitHubFileReadInput, GitHubRepoTreeInput } from './lib/github'
import { LspReferencesInput, LspRenameInput, LspSymbolsInput } from './lib/lsp'
import { ArtifactTemplateReadInput, ArtifactTemplatesListInput } from './lib/template'
import { TypstCompileInput } from './lib/typst'
import { lspReferences, lspRename, lspSymbols } from './lsp'
import { createNotificationRunner, normalizeNotificationConfig } from './notifications'
import { executeTool } from './shared'
import { artifactTemplateRead, artifactTemplatesList } from './templates'
import { typstCompile } from './typst'

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

function githubTools(options: PluginOptions | undefined) {
	const github = normalizeGitHubPluginConfig(options)
	if (!github.enabled) return {}

	return {
		github_code_search: tool({
			description: 'Search remote GitHub source code.',
			args: {
				query: tool.schema.string(),
				repos: tool.schema.array(tool.schema.string()).optional(),
				owner: tool.schema.string().optional(),
				language: tool.schema.string().optional(),
				filename: tool.schema.string().optional(),
				extension: tool.schema.string().optional(),
				maxResults: tool.schema.number().optional(),
			},
			execute(args, context) {
				return executeTool('github_code_search', GitHubCodeSearchInput, args, context, (input) =>
					githubCodeSearch(github.config, input),
				)
			},
		}),
		github_file_read: tool({
			description: 'Read a specific file from a GitHub repo.',
			args: {
				repo: tool.schema.string(),
				path: tool.schema.string(),
				ref: tool.schema.string().optional(),
				maxBytes: tool.schema.number().optional(),
			},
			execute(args, context) {
				return executeTool('github_file_read', GitHubFileReadInput, args, context, (input) =>
					githubFileRead(github.config, input),
				)
			},
		}),
		github_repo_tree: tool({
			description: 'Inspect repository structure when GitHub code search is insufficient.',
			args: {
				repo: tool.schema.string(),
				ref: tool.schema.string().optional(),
				pathPrefix: tool.schema.string().optional(),
				recursive: tool.schema.boolean().optional(),
				maxEntries: tool.schema.number().optional(),
			},
			execute(args, context) {
				return executeTool('github_repo_tree', GitHubRepoTreeInput, args, context, (input) =>
					githubRepoTree(github.config, input),
				)
			},
		}),
	}
}

export function createLimitless(): Plugin {
	return async (pluginInput, options) => {
		const notifications = createNotificationRunner(normalizeNotificationConfig(options))

		return {
			event: async ({ event }) => {
				await notifications.handleEvent(event)
			},
			'tool.execute.before': async (input) => {
				if (input.tool === 'question') await notifications.notify('question')
			},
			tool: {
				artifact_create: tool({
					description:
						'Create a durable project-scoped artifact workspace, optionally from a built-in artifact template.',
					args: {
						kind: tool.schema.string().optional(),
						title: tool.schema.string().optional(),
						slug: tool.schema.string().optional(),
						template: tool.schema.string().optional(),
					},
					execute(args, context) {
						return executeTool('artifact_create', ArtifactCreateInput, args, context, (input) =>
							artifactCreate(input, context),
						)
					},
				}),
				artifact_list: tool({
					description: 'List durable project-scoped artifact workspaces.',
					args: {
						kind: tool.schema.string().optional(),
						template: tool.schema.string().optional(),
					},
					execute(args, context) {
						return executeTool('artifact_list', ArtifactListInput, args, context, (input) =>
							artifactList(input, context),
						)
					},
				}),
				artifact_templates_list: tool({
					description: 'List built-in artifact templates available to artifact_create.',
					args: {},
					execute(args, context) {
						return executeTool(
							'artifact_templates_list',
							ArtifactTemplatesListInput,
							args,
							context,
							(input) => artifactTemplatesList(input),
						)
					},
				}),
				artifact_template_read: tool({
					description:
						'Read a text file from a built-in artifact template without creating an artifact (for example the sphere-showcase authoring reference).',
					args: {
						template: tool.schema.string(),
						file: tool.schema.string(),
					},
					execute(args, context) {
						return executeTool(
							'artifact_template_read',
							ArtifactTemplateReadInput,
							args,
							context,
							(input) => artifactTemplateRead(input),
						)
					},
				}),
				typst_compile: tool({
					description: 'Compile a Typst document artifact to PDF using the packaged Typst binary.',
					args: {
						artifact: tool.schema.string(),
						entry: tool.schema.string().optional(),
						format: tool.schema.string().optional(),
						timeoutMs: tool.schema.number().optional(),
					},
					execute(args, context) {
						return executeTool('typst_compile', TypstCompileInput, args, context, (input) =>
							typstCompile(input, context),
						)
					},
				}),
				ast_grep_search: tool({
					description: 'Search code with ast-grep using the packaged binary.',
					args: {
						pattern: tool.schema.string(),
						lang: tool.schema.string().optional(),
						language: tool.schema.string().optional(),
						paths: tool.schema.array(tool.schema.string()).optional(),
						workspace: tool.schema.string().optional(),
						json: tool.schema.boolean().optional(),
						timeoutMs: tool.schema.number().optional(),
					},
					execute(args, context) {
						return executeTool('ast_grep_search', AstGrepSearchInput, args, context, (input) =>
							astGrepSearch(input, context),
						)
					},
				}),
				ast_grep_replace: tool({
					description: 'Rewrite code with ast-grep. Dry-run is enabled by default.',
					args: {
						pattern: tool.schema.string(),
						rewrite: tool.schema.string(),
						lang: tool.schema.string().optional(),
						language: tool.schema.string().optional(),
						paths: tool.schema.array(tool.schema.string()).optional(),
						workspace: tool.schema.string().optional(),
						dryRun: tool.schema.boolean().optional(),
						timeoutMs: tool.schema.number().optional(),
					},
					execute(args, context) {
						return executeTool('ast_grep_replace', AstGrepReplaceInput, args, context, (input) =>
							astGrepReplace(input, context),
						)
					},
				}),
				lsp_diagnostics: tool({
					description: 'Run safe local diagnostics for TS/JS projects.',
					args: pathArgs,
					execute(args, context) {
						return executeTool('lsp_diagnostics', DiagnosticsInput, args, context, (input) =>
							lspDiagnostics(input, context),
						)
					},
				}),
				lsp_references: tool({
					description:
						'Find references through the configured language server for a zero-based file position.',
					args: {
						...positionArgs,
						includeDeclaration: tool.schema.boolean().optional(),
						maxResults: tool.schema.number().optional(),
					},
					execute(args, context) {
						return executeTool('lsp_references', LspReferencesInput, args, context, (input) =>
							lspReferences(pluginInput, input, context),
						)
					},
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
					execute(args, context) {
						return executeTool('lsp_symbols', LspSymbolsInput, args, context, (input) =>
							lspSymbols(pluginInput, input, context),
						)
					},
				}),
				lsp_rename: tool({
					description:
						'Preview rename edits from the configured language server without writing files.',
					args: {
						...positionArgs,
						newName: tool.schema.string(),
					},
					execute(args, context) {
						return executeTool('lsp_rename', LspRenameInput, args, context, (input) =>
							lspRename(pluginInput, input, context),
						)
					},
				}),
				...githubTools(options),
			},
		}
	}
}

export default createLimitless()
