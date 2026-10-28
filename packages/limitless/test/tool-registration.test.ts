import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { limitlessTools, resolvePluginConfigs } from '../index'
import { taskBoardTools } from '../tools/tasks/tools'
import { testToolExecution, testToolExecutor } from './execution'

describe('OpenCode 2 tool registrations', () => {
	test.each([
		'draft-07',
		'draft-2020-12',
	] as const)('exports provider-compatible %s schemas for every tool', async (target) => {
		const configs = await Effect.runPromise(
			resolvePluginConfigs({
				github: { enable: true, allowUnrestrictedRepos: true },
				lsp: {},
				linear: {
					enable: true,
					teamId: '00000000-0000-4000-8000-00000000000a',
					projectId: '00000000-0000-4000-8000-00000000000b',
					states: {
						in_progress: '00000000-0000-4000-8000-000000000001',
						in_review: '00000000-0000-4000-8000-000000000002',
						done: '00000000-0000-4000-8000-000000000003',
						canceled: '00000000-0000-4000-8000-000000000004',
					},
				},
			}),
		)
		if (configs.taskBoardConfig === undefined) throw new Error('The task board must be enabled')
		const execution = testToolExecution('/project')
		const executeTool = testToolExecutor(execution, configs.lspConfig.servers)
		const tools = {
			...limitlessTools(executeTool, configs.githubConfig, configs.githubCloneRuntime),
			...taskBoardTools(executeTool, configs.taskBoardConfig, {
				openBoard: () => Effect.die('unused'),
				readSession: () => Effect.die('unused'),
			}),
		}

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
