import * as fs from 'node:fs/promises'
import { Effect, Exit, Scope, Stream } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import plugin, { resolvePluginConfigs } from '../index'
import { decodeTaskBoardConfig } from '../tools/tasks/config'

vi.mock('node:fs/promises', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:fs/promises')>()),
}))

const ids = {
	teamId: '00000000-0000-4000-8000-00000000000A',
	projectId: '00000000-0000-4000-8000-00000000000b',
	states: {
		in_progress: '00000000-0000-4000-8000-000000000001',
		in_review: '00000000-0000-4000-8000-000000000002',
		done: '00000000-0000-4000-8000-000000000003',
		canceled: '00000000-0000-4000-8000-000000000004',
	},
}
const TOKEN_FILE = '/run/secrets/limitless-test-linear-token'
const taskTools = ['task_create', 'task_list', 'task_review', 'task_report']

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe('configuration', () => {
	const decode = (options: unknown) =>
		Effect.runPromise(Effect.result(decodeTaskBoardConfig(options)))

	test('is opt-in and ignores the rest of a disabled block', async () => {
		for (const options of [undefined, {}, { linear: {} }, { linear: { enable: false, teamId: 7 } }])
			expect(await decode(options)).toMatchObject({ _tag: 'Success', success: undefined })
	})

	test('normalizes an enabled board with the default token variable', async () => {
		expect(await decode({ linear: { enable: true, ...ids } })).toMatchObject({
			_tag: 'Success',
			success: {
				teamId: ids.teamId.toLowerCase(),
				projectId: ids.projectId,
				states: ids.states,
				tokenEnv: 'LINEAR_API_KEY',
			},
		})
		expect(
			await decode({
				linear: { enable: true, ...ids, tokenEnv: 'WORK_LINEAR', tokenFile: TOKEN_FILE },
			}),
		).toMatchObject({ success: { tokenEnv: 'WORK_LINEAR', tokenFile: TOKEN_FILE } })
	})

	test.each([
		['missing states', { enable: true, teamId: ids.teamId, projectId: ids.projectId }],
		['a non-UUID team', { enable: true, ...ids, teamId: 'ENG' }],
		[
			'shared states',
			{ enable: true, ...ids, states: { ...ids.states, done: ids.states.canceled } },
		],
		['an invalid variable name', { enable: true, ...ids, tokenEnv: 'LINEAR-KEY' }],
		['a relative token file', { enable: true, ...ids, tokenFile: 'secrets/linear' }],
		['an inline token', { enable: true, ...ids, token: 'lin_api_inline' }],
		['a misspelled token file', { enable: true, ...ids, tokenfile: TOKEN_FILE }],
	])('rejects %s', async (_name, linear) => {
		expect(await decode({ linear })).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'TaskBoardConfigError' },
		})
	})

	test('an invalid board disables only its own tools', async () => {
		const configs = await Effect.runPromise(
			resolvePluginConfigs({ linear: { enable: true, teamId: 'bad' }, lsp: {} }),
		)
		expect(configs.taskBoardConfig).toBeUndefined()
		expect(configs.lspConfig).toBeDefined()
	})
})

async function load(options: unknown) {
	const tools = new Map<string, unknown>()
	const hooks = new Map<string, Array<(input: unknown) => Effect.Effect<void>>>()
	const registration = { dispose: Effect.void }
	const ctx = {
		options,
		app: { version: '2.1.4' },
		location: { directory: '/project', project: { id: 'project', directory: '/project' } },
		agent: { list: () => Effect.succeed({ data: [] }) },
		event: { subscribe: () => Stream.empty },
		session: {
			// T3's context hook reads the session; an ordinary one carries no T3 rules.
			get: () => Effect.succeed({ id: 'ses_any', permissions: [] }),
			hook: (name: string, callback: (input: unknown) => Effect.Effect<void>) =>
				Effect.sync(() => hooks.set(name, [...(hooks.get(name) ?? []), callback])).pipe(
					Effect.as(registration),
				),
		},
		tool: {
			transform: (callback: (editor: unknown) => void) =>
				Effect.sync(() =>
					callback({
						add: (tool: { name: string }) => tools.set(tool.name, tool),
						get: () => undefined,
						update: () => {},
					}),
				).pipe(Effect.as(registration)),
		},
		provider: { transform: () => Effect.succeed(registration) },
	}
	const scope = await Effect.runPromise(Scope.make())
	try {
		await Effect.runPromise(
			// biome-ignore lint/suspicious/noExplicitAny: a minimal host stands in for OpenCode's plugin context.
			plugin.effect(ctx as any).pipe(Effect.provideService(Scope.Scope, scope)),
		)
	} finally {
		await Effect.runPromise(Scope.close(scope, Exit.void))
	}
	const context = async (agent: string, offered: Array<string>) => {
		const request = {
			sessionID: 'ses_any',
			agent,
			tools: Object.fromEntries(offered.map((name) => [name, {}])),
			system: [] as Array<{ text: string }>,
			messages: [],
		}
		for (const hook of hooks.get('context') ?? []) await Effect.runPromise(hook(request))
		return request.system.map((part) => part.text).join('\n')
	}
	return { tools: [...tools.keys()], context }
}

describe('plugin registration', () => {
	test('adds no task tools or guidance unless enabled', async () => {
		const disabled = await load({ linear: { enable: false, ...ids } })
		expect(disabled.tools).not.toEqual(expect.arrayContaining(['task_create']))
		expect(disabled.tools).toContain('github_clone')
		expect(await disabled.context('lead', taskTools)).not.toContain('Linear task board')

		const invalid = await load({ linear: { enable: true } })
		expect(invalid.tools.filter((name) => name.startsWith('task_'))).toEqual([])
	})

	test('loads an enabled board without credentials or network access', async () => {
		const fetch = vi.fn(() => {
			throw new Error('no network during load')
		})
		vi.stubGlobal('fetch', fetch)
		const readFile = vi.spyOn(fs, 'readFile')
		const enabled = await load({ linear: { enable: true, ...ids, tokenFile: TOKEN_FILE } })
		expect(enabled.tools.filter((name) => name.startsWith('task_'))).toEqual(taskTools)
		expect(fetch).not.toHaveBeenCalled()
		expect(readFile.mock.calls.map(([path]) => String(path))).not.toContain(TOKEN_FILE)

		expect(await enabled.context('lead', ['task_create', 'task_list', 'task_review'])).toContain(
			'call `task_create`',
		)
		expect(await enabled.context('unit', ['task_report'])).toContain('`result: "ready"` only once')
		expect(await enabled.context('limitless', taskTools)).toBe('')
		expect(await enabled.context('lead', [])).toBe('')
	})
})
