import type { PluginInput } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin'
import { Effect, Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { createLimitless, resolvePluginConfigs } from '../index'
import { ArtifactCreateInput } from '../tools/artifacts/create'
import { ArtifactListInput } from '../tools/artifacts/list'
import { ArtifactTemplateReadInput, ArtifactTemplatesListInput } from '../tools/artifacts/templates'
import { TypstCompileInput } from '../tools/artifacts/typst'
import { AstGrepReplaceInput, AstGrepSearchInput } from '../tools/ast-grep'
import { DiagnosticsInput } from '../tools/diagnostics'
import { GitHubCloneInput } from '../tools/github/clone-schema'
import { LspCallHierarchyInput } from '../tools/lsp/call-hierarchy'
import { LspDefinitionInput } from '../tools/lsp/definition'
import { LspHoverInput } from '../tools/lsp/hover'
import { LspImplementationInput } from '../tools/lsp/implementation'
import { LspReferencesInput } from '../tools/lsp/references'
import { LspRenameInput } from '../tools/lsp/rename'
import { LspSymbolsInput } from '../tools/lsp/symbols'

const contracts = [
	{
		name: 'artifact_create',
		input: ArtifactCreateInput,
		valid: { title: 'Brief', slug: 'brief', template: 'brief' },
	},
	{ name: 'artifact_list', input: ArtifactListInput, valid: { template: 'brief' } },
	{ name: 'artifact_templates_list', input: ArtifactTemplatesListInput, valid: {} },
	{
		name: 'artifact_template_read',
		input: ArtifactTemplateReadInput,
		valid: { template: 'brief', file: 'main.typ' },
	},
	{
		name: 'typst_compile',
		input: TypstCompileInput,
		valid: { artifact: 'brief', entry: 'main.typ', format: 'pdf', timeoutMs: 100 },
	},
	{
		name: 'ast_grep_search',
		input: AstGrepSearchInput,
		valid: {
			pattern: 'foo',
			lang: 'ts',
			language: 'typescript',
			paths: ['src'],
			workspace: '.',
			json: true,
			timeoutMs: 100,
		},
	},
	{
		name: 'ast_grep_replace',
		input: AstGrepReplaceInput,
		valid: {
			pattern: 'foo',
			rewrite: 'bar',
			lang: 'ts',
			language: 'typescript',
			paths: ['src'],
			workspace: '.',
			dryRun: true,
			timeoutMs: 100,
		},
	},
	{
		name: 'lsp_diagnostics',
		input: DiagnosticsInput,
		valid: { workspace: '.', filePath: 'src/a.ts', path: 'src/a.ts' },
	},
	{
		name: 'lsp_definition',
		input: LspDefinitionInput,
		valid: {
			workspace: '.',
			filePath: 'src/a.ts',
			path: 'src/a.ts',
			server: 'typescript',
			timeoutMs: 100,
			offset: 0,
			line: 0,
			character: 0,
			maxResults: 10,
		},
	},
	{
		name: 'lsp_hover',
		input: LspHoverInput,
		valid: {
			workspace: '.',
			filePath: 'src/a.ts',
			path: 'src/a.ts',
			server: 'typescript',
			timeoutMs: 100,
			offset: 0,
			line: 0,
			character: 0,
		},
	},
	{
		name: 'lsp_implementation',
		input: LspImplementationInput,
		valid: {
			workspace: '.',
			filePath: 'src/a.ts',
			path: 'src/a.ts',
			server: 'typescript',
			timeoutMs: 100,
			offset: 0,
			line: 0,
			character: 0,
			maxResults: 10,
		},
	},
	{
		name: 'lsp_call_hierarchy',
		input: LspCallHierarchyInput,
		valid: {
			workspace: '.',
			filePath: 'src/a.ts',
			path: 'src/a.ts',
			server: 'typescript',
			timeoutMs: 100,
			offset: 0,
			line: 0,
			character: 0,
			maxResults: 10,
		},
	},
	{
		name: 'lsp_references',
		input: LspReferencesInput,
		valid: {
			workspace: '.',
			filePath: 'src/a.ts',
			path: 'src/a.ts',
			server: 'typescript',
			timeoutMs: 100,
			offset: 0,
			line: 0,
			character: 0,
			includeDeclaration: true,
			maxResults: 10,
		},
	},
	{
		name: 'lsp_symbols',
		input: LspSymbolsInput,
		valid: {
			workspace: '.',
			filePath: 'src/a.ts',
			path: 'src/a.ts',
			server: 'typescript',
			timeoutMs: 100,
			query: 'symbol',
			maxResults: 10,
		},
	},
	{
		name: 'lsp_rename',
		input: LspRenameInput,
		valid: {
			workspace: '.',
			filePath: 'src/a.ts',
			path: 'src/a.ts',
			server: 'typescript',
			timeoutMs: 100,
			offset: 0,
			line: 0,
			character: 0,
			newName: 'renamed',
		},
	},
	{ name: 'github_clone', input: GitHubCloneInput, valid: { repo: 'owner/repo', ref: 'main' } },
] as const

describe('OpenCode tool transport parity', () => {
	test('allocates GitHub serialization state per plugin instance', async () => {
		const [first, second] = await Effect.runPromise(
			Effect.all([resolvePluginConfigs(undefined), resolvePluginConfigs(undefined)]),
		)

		expect(first.githubCloneRuntime.targetSemaphore).not.toBe(
			second.githubCloneRuntime.targetSemaphore,
		)
	})

	test('registers every tool and mirrors Effect argument keys and optionality in Zod', async () => {
		// Tool definitions close over PluginInput but do not inspect it until an LSP tool executes.
		const pluginInput = Object.create(null) as PluginInput
		const hooks = await createLimitless()(pluginInput, {
			github: { enable: true, allowUnrestrictedRepos: true },
		})
		const registrations = hooks.tool ?? {}
		const expectedNames = contracts.map(({ name }) => name).sort()
		expect(Object.keys(registrations).sort()).toEqual(expectedNames)

		for (const contract of contracts) {
			const registration = registrations[contract.name]
			expect(registration, contract.name).toBeDefined()
			if (registration === undefined) continue

			const zodSchema = tool.schema.object(registration.args)
			const argumentKeys = Object.keys(contract.input.fields).sort()
			expect(Object.keys(registration.args).sort(), contract.name).toEqual(argumentKeys)
			expect(zodSchema.safeParse(contract.valid).success, `${contract.name} valid Zod input`).toBe(
				true,
			)
			expect(
				Option.isSome(Schema.decodeUnknownOption(contract.input)(contract.valid)),
				`${contract.name} valid Effect input`,
			).toBe(true)

			for (const key of argumentKeys) {
				const withoutKey = Object.fromEntries(
					Object.entries(contract.valid).filter(([candidate]) => candidate !== key),
				)
				const zodAccepts = zodSchema.safeParse(withoutKey).success
				const effectAccepts = Option.isSome(Schema.decodeUnknownOption(contract.input)(withoutKey))
				expect(zodAccepts, `${contract.name}.${key} optionality`).toBe(effectAccepts)
			}
		}
	})
})
