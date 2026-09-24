import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { limitlessTools, resolvePluginConfigs } from '../index'
import { testToolExecution, testToolExecutor } from './execution'

describe('OpenCode 2 tool registrations', () => {
	test.each([
		'draft-07',
		'draft-2020-12',
	] as const)('exports provider-compatible %s schemas for every tool', async (target) => {
		const configs = await Effect.runPromise(
			resolvePluginConfigs({ github: { enable: true, allowUnrestrictedRepos: true }, lsp: {} }),
		)
		const execution = testToolExecution('/project')
		const tools = limitlessTools(
			testToolExecutor(execution, configs.lspConfig.servers),
			configs.githubConfig,
			configs.githubCloneRuntime,
		)

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
