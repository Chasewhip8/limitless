import { Tool } from '@opencode-ai/schema/tool'
import { Effect, Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { limitlessTools, registerLimitlessTools, resolvePluginConfigs } from '../index'
import { makeToolExecutor } from '../plugin/tool-boundary'
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
import { settleTestTool, testToolExecution, testToolExecutor } from './execution'

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

	test('generates provider-compatible object schemas for every tool input', () => {
		for (const contract of contracts) {
			const jsonSchema = Schema.toStandardJSONSchemaV1(contract.input)[
				'~standard'
			].jsonSchema.input({ target: 'draft-2020-12' })
			expect(jsonSchema.type, `${contract.name} must generate an object schema`).toBe('object')
		}
	})

	test('exposes every tool directly with codemode disabled', async () => {
		const tools = await Effect.runPromise(makeTools())
		const registrations: Array<{ readonly name: string; readonly codemode: boolean | undefined }> =
			[]

		registerLimitlessTools(
			{
				add: (tool) => {
					registrations.push({ name: tool.name, codemode: tool.options?.codemode })
				},
			},
			tools,
		)

		expect(registrations).toHaveLength(16)
		expect(registrations.every(({ codemode }) => codemode === false)).toBe(true)
	})

	test('routes all 16 tools through the shared session-directory boundary', async () => {
		const configs = await Effect.runPromise(
			resolvePluginConfigs({
				github: { enable: true, allowUnrestrictedRepos: true },
				lsp: {},
			}),
		)
		const execution = testToolExecution('/project')
		const calls: Array<string> = []
		const boundaryFailure = new Tool.Error({ message: 'session boundary reached' })
		const execute = makeToolExecutor(
			(sessionID) =>
				Effect.sync(() => calls.push(sessionID)).pipe(Effect.andThen(Effect.fail(boundaryFailure))),
			configs.lspConfig,
		)
		const tools = limitlessTools(execute, configs.githubConfig, configs.githubCloneRuntime)

		for (const contract of contracts) {
			const failure = await Effect.runPromise(
				settleTestTool(tools[contract.name], contract.valid, execution).pipe(Effect.flip),
			)
			expect(failure, contract.name).toBe(boundaryFailure)
		}
		expect(calls).toEqual(contracts.map(() => execution.sessionId))
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
