import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { limitlessTools, resolvePluginConfigs } from '../index'
import { testToolExecution, testToolExecutor } from './execution'

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
	test('validates integer LSP inputs through the detached schema boundary', async () => {
		const tools = await Effect.runPromise(makeTools())
		const valid = await tools.lsp_hover.input['~standard'].validate({
			filePath: 'src/a.ts',
			line: 7,
			character: 12,
			timeoutMs: 60_000,
		})
		const numericString = await tools.lsp_hover.input['~standard'].validate({
			filePath: 'src/a.ts',
			line: '7',
			character: 12,
		})

		expect(valid).toMatchObject({
			value: { filePath: 'src/a.ts', line: 7, character: 12, timeoutMs: 60_000 },
		})
		expect(numericString).toHaveProperty('issues')
	})

	test('validates non-empty ast-grep patterns through the detached schema boundary', async () => {
		const tools = await Effect.runPromise(makeTools())
		const validated = await tools.ast_grep_replace.input['~standard'].validate({
			pattern: 'Option.getOrThrow(hashApiKey(Redacted.make($KEY)))',
			rewrite: 'apiKeyHash($KEY)',
			lang: 'typescript',
			workspace: '/home/chase/pay/onboarding',
			dryRun: false,
		})

		expect(validated).toMatchObject({
			value: {
				pattern: 'Option.getOrThrow(hashApiKey(Redacted.make($KEY)))',
				rewrite: 'apiKeyHash($KEY)',
				dryRun: false,
			},
		})
	})

	test('normalizes GitHub repositories through the detached schema boundary', async () => {
		const tools = await Effect.runPromise(makeTools())
		const validated = await tools.github_clone.input['~standard'].validate({
			repo: 'Sphere-Laboratories/infrastructure',
		})

		expect(validated).toEqual({
			value: { repo: 'sphere-laboratories/infrastructure' },
		})
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
