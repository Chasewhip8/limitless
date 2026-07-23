import { Effect, Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { limitlessTools, registerLimitlessTools, resolvePluginConfigs } from '../index'
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
import { testToolExecution, testToolExecutor } from './execution'

const contracts = [
	{ name: 'artifact_create', input: ArtifactCreateInput, valid: { slug: 'brief' } },
	{ name: 'artifact_list', input: ArtifactListInput, valid: {} },
	{ name: 'artifact_templates_list', input: ArtifactTemplatesListInput, valid: {} },
	{
		name: 'artifact_template_read',
		input: ArtifactTemplateReadInput,
		valid: { template: 'brief', file: 'main.typ' },
	},
	{ name: 'typst_compile', input: TypstCompileInput, valid: { artifact: 'brief' } },
	{ name: 'ast_grep_search', input: AstGrepSearchInput, valid: { pattern: 'foo' } },
	{
		name: 'ast_grep_replace',
		input: AstGrepReplaceInput,
		valid: { pattern: 'foo', rewrite: 'bar' },
	},
	{ name: 'lsp_diagnostics', input: DiagnosticsInput, valid: {} },
	{
		name: 'lsp_definition',
		input: LspDefinitionInput,
		valid: { filePath: 'src/a.ts', offset: 0 },
	},
	{
		name: 'lsp_hover',
		input: LspHoverInput,
		valid: { filePath: 'src/a.ts', offset: 0 },
	},
	{
		name: 'lsp_implementation',
		input: LspImplementationInput,
		valid: { filePath: 'src/a.ts', offset: 0 },
	},
	{
		name: 'lsp_call_hierarchy',
		input: LspCallHierarchyInput,
		valid: { filePath: 'src/a.ts', offset: 0 },
	},
	{
		name: 'lsp_references',
		input: LspReferencesInput,
		valid: { filePath: 'src/a.ts', offset: 0 },
	},
	{ name: 'lsp_symbols', input: LspSymbolsInput, valid: {} },
	{
		name: 'lsp_rename',
		input: LspRenameInput,
		valid: { filePath: 'src/a.ts', offset: 0, newName: 'renamed' },
	},
	{ name: 'github_clone', input: GitHubCloneInput, valid: { repo: 'owner/repo' } },
] as const

const makeTools = Effect.fn('makeTestTools')(function* () {
	const configs = yield* resolvePluginConfigs({
		github: { enable: true, allowUnrestrictedRepos: true },
		lsp: {},
	})
	const execution = testToolExecution('/project')
	return limitlessTools(
		testToolExecutor(execution, configs.lspConfig.servers),
		configs.githubConfig,
		configs.githubCloneRuntime,
	)
})

describe('OpenCode 2 tool registrations', () => {
	test('registers all 16 tools with their Effect Schema contracts', async () => {
		const tools = await Effect.runPromise(makeTools())
		expect(Object.keys(tools).sort()).toEqual(contracts.map(({ name }) => name).sort())

		for (const contract of contracts) {
			const definition = tools[contract.name]
			expect(definition.input, contract.name).toBe(contract.input)
			expect(
				Option.isSome(Schema.decodeUnknownOption(definition.input)(contract.valid)),
				`${contract.name} accepts its valid input`,
			).toBe(true)
		}
	})

	test('exposes every tool directly with codemode disabled', async () => {
		const tools = await Effect.runPromise(makeTools())
		const registrations: Array<{ readonly name: string; readonly codemode: boolean | undefined }> =
			[]

		registerLimitlessTools(
			{
				add: (name, _tool, options) => {
					registrations.push({ name, codemode: options?.codemode })
				},
			},
			tools,
		)

		expect(registrations).toHaveLength(16)
		expect(registrations.every(({ codemode }) => codemode === false)).toBe(true)
	})

	test('allocates GitHub serialization state per plugin activation', async () => {
		const [first, second] = await Effect.runPromise(
			Effect.all([resolvePluginConfigs({ lsp: {} }), resolvePluginConfigs({ lsp: {} })]),
		)
		expect(first.githubCloneRuntime.targetSemaphore).not.toBe(
			second.githubCloneRuntime.targetSemaphore,
		)
	})
})
