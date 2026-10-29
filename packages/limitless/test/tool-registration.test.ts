import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { limitlessTools, registerLimitlessTools, resolvePluginConfigs } from '../index'
import { testToolExecution, testToolExecutor } from './execution'

describe('OpenCode 2 tool registrations', () => {
	test('disabled GitHub support exposes no clone tool even with repository access configured', async () => {
		const configs = await Effect.runPromise(
			resolvePluginConfigs({
				github: { enable: false, allowedRepos: ['owner/repo'], allowUnrestrictedRepos: true },
			}),
		)
		const tools = limitlessTools(
			testToolExecutor(testToolExecution('/project')),
			configs.githubConfig,
			configs.githubCloneRuntime,
		)
		const registered: Array<string> = []
		registerLimitlessTools({ add: (tool) => registered.push(tool.name) }, tools)
		expect(Object.keys(tools).sort()).toEqual(['artifact_create', 'artifact_list'])
		expect(registered.sort()).toEqual(['artifact_create', 'artifact_list'])
	})

	test.each([
		'draft-07',
		'draft-2020-12',
	] as const)('exports provider-compatible %s schemas for every tool', async (target) => {
		const configs = await Effect.runPromise(
			resolvePluginConfigs({ github: { enable: true, allowUnrestrictedRepos: true } }),
		)
		const execution = testToolExecution('/project')
		const tools = limitlessTools(
			testToolExecutor(execution),
			configs.githubConfig,
			configs.githubCloneRuntime,
		)

		const expectedTools = ['artifact_create', 'artifact_list', 'github_clone']
		expect(Object.keys(tools).sort()).toEqual(expectedTools)
		const registered: Array<string> = []
		registerLimitlessTools({ add: (tool) => registered.push(tool.name) }, tools)
		expect(registered.sort()).toEqual(expectedTools)

		for (const [name, tool] of Object.entries(tools)) {
			// Providers reject function parameters without a top-level object schema.
			const input = tool.input['~standard'].jsonSchema.input({ target })
			expect(input, name).toHaveProperty('type', 'object')
			expect(input, name).not.toHaveProperty('anyOf')
			expect(input, name).not.toHaveProperty('oneOf')
			expect(JSON.parse(JSON.stringify(input)), name).toEqual(input)

			if (tool.output === undefined) throw new Error(`${name} is missing its output schema`)
			const output = tool.output['~standard'].jsonSchema.output({ target })
			expect(JSON.parse(JSON.stringify(output)), name).toEqual(output)
		}
	})
})
