import type { Plugin } from '@opencode/plugin/effect'
import { Session } from '@opencode/schema/session'
import { Tool } from '@opencode/schema/tool'
import { Effect, Fiber } from 'effect'
import { expect, test, vi } from 'vitest'
import { registerUnits } from '../plugin/units'

const parentID = Session.ID.make('ses_parent')
const childID = Session.ID.make('ses_child')
const childDirectory = '/worktrees/unit-ses_child'
const input = {
	agent: 'unit',
	description: 'API/foo design',
	prompt: 'Approved brief',
	background: true,
}

async function harness(version = '2.1.4') {
	const parent = { id: parentID, location: { directory: '/project' }, subpath: '', metadata: {} }
	const child = {
		id: childID,
		agent: 'unit',
		parentID,
		location: { directory: '/project' },
		metadata: {} as Record<string, unknown>,
	}
	const nativePrompt = vi.fn()
	const progress = vi.fn(() => Effect.void)
	const context = {
		sessionID: parentID,
		agent: 'lead',
		id: 'call_unit',
		messageID: 'msg_parent',
		progress,
	} as unknown as Tool.Context
	const get = vi.fn(({ sessionID }: { sessionID: string }) =>
		Effect.succeed(sessionID === parentID ? parent : child),
	)
	const createWorktree = vi.fn(
		(): Effect.Effect<{ directory: string }, Tool.Error> =>
			Effect.succeed({ directory: childDirectory }),
	)
	const readAgent = vi.fn(() =>
		Effect.succeed({ data: { model: { providerID: 'test', id: 'destination', variant: 'deep' } } }),
	)
	const switchModel = vi.fn(() => Effect.void)
	const hooks = new Map<string, (input: { sessionID: Session.ID }) => Effect.Effect<void>>()
	const nativeExecute = vi.fn((args: unknown, invocation: Tool.Context) =>
		Effect.gen(function* () {
			yield* invocation.progress({ sessionID: childID, status: 'running' })
			nativePrompt(args, invocation)
			return {
				output: { sessionID: childID, status: 'running', output: 'Native running result' },
				content: 'Native running result',
			}
		}),
	)
	const native = {
		name: 'subagent',
		description: 'Native subagent',
		execute: nativeExecute,
	} as unknown as Tool.Info
	let current = native
	let transform: ((editor: unknown) => void) | undefined
	const replay = () => {
		current = { ...native }
		transform?.({
			get: () => current,
			update: (_name: string, update: (tool: Tool.Info) => void) => update(current),
		})
	}
	const ctx = {
		app: { version },
		location: { project: { id: 'project-id', directory: '/project' } },
		agent: { get: readAgent },
		worktree: { create: createWorktree },
		session: {
			get,
			hook: (name: string, hook: (input: { sessionID: Session.ID }) => Effect.Effect<void>) =>
				Effect.sync(() => hooks.set(name, hook)),
			update: ({ metadata }: { metadata: Record<string, unknown> }) =>
				Effect.sync(() => {
					child.metadata = metadata
				}),
			move: ({ directory }: { directory: string }) =>
				Effect.sync(() => {
					child.location.directory = directory
				}),
			wait: () => Effect.void,
			switchModel,
		},
		tool: {
			transform: (callback: typeof transform) =>
				Effect.sync(() => {
					transform = callback
					replay()
				}),
		},
	}
	await Effect.runPromise(registerUnits(ctx as unknown as Plugin.Context).pipe(Effect.scoped))
	const promptHook = hooks.get('prompt')
	if (!promptHook) throw new Error('Missing Unit prompt hook')
	const run = (args: unknown = input) => current.execute(args, context)
	return {
		parent,
		child,
		native,
		current: () => current,
		nativeExecute,
		nativePrompt,
		context,
		progress,
		createWorktree,
		get,
		readAgent,
		switchModel,
		replay,
		run,
		prompt: () => Effect.runPromise(promptHook({ sessionID: childID })),
	}
}

test('native Unit placement keeps the executor, result and invocation identity', async () => {
	const host = await harness()
	const result = await Effect.runPromise(host.run())
	expect(host.nativeExecute).toHaveBeenCalledWith(
		input,
		expect.objectContaining({
			sessionID: parentID,
			messageID: 'msg_parent',
			id: 'call_unit',
			agent: 'lead',
		}),
	)
	expect(host.createWorktree).toHaveBeenCalledExactlyOnceWith({
		projectID: 'project-id',
		from: '/project',
		name: `unit-${childID}`,
	})
	expect(host.child.location.directory).toBe(childDirectory)
	expect(host.child.parentID).toBe(parentID)
	expect(result).toEqual({
		output: { sessionID: childID, status: 'running', output: 'Native running result' },
		content: 'Native running result',
	})
	expect(host.progress.mock.calls[0]).toEqual([{ sessionID: childID, status: 'running' }])
	expect(host.nativePrompt).toHaveBeenCalledOnce()
	await host.prompt()
	expect(host.switchModel).toHaveBeenCalledExactlyOnceWith({
		sessionID: childID,
		model: { providerID: 'test', id: 'destination', variant: 'deep' },
	})
	await host.prompt()
	expect(host.switchModel).toHaveBeenCalledOnce()
})

test('Lead subdirectories use the checkout root and keep their relative location', async () => {
	const host = await harness()
	host.parent.location.directory = '/project/packages/client'
	host.parent.subpath = 'packages/client'
	await Effect.runPromise(host.run())
	expect(host.createWorktree).toHaveBeenCalledWith({
		projectID: 'project-id',
		from: '/project',
		name: `unit-${childID}`,
	})
	expect(host.child.location.directory).toBe(`${childDirectory}/packages/client`)
	await Effect.runPromise(host.run({ ...input, sessionID: childID }))
	expect(host.createWorktree).toHaveBeenCalledOnce()
})

test.each([
	undefined,
	'test/explicit#high',
])('partially initialized continuation preserves requested model %s', async (model) => {
	const host = await harness()
	await Effect.runPromise(host.run())
	// Placement finished, but no Unit prompt has been admitted yet.
	await Effect.runPromise(host.run({ ...input, sessionID: childID, ...(model ? { model } : {}) }))
	await host.prompt()
	expect(host.createWorktree).toHaveBeenCalledOnce()
	if (model) expect(host.switchModel).not.toHaveBeenCalled()
	else expect(host.switchModel).toHaveBeenCalledOnce()
})

test('explicit model selection and inherited metadata are not overwritten', async () => {
	const host = await harness()
	await Effect.runPromise(host.run({ ...input, model: 'test/explicit#high' }))
	await host.prompt()
	expect(host.readAgent).not.toHaveBeenCalled()
	host.child.metadata['limitless.unit'] = {
		sessionID: parentID,
		worktree: childDirectory,
		directory: childDirectory,
		initializeModel: true,
	}
	await host.prompt()
	expect(host.readAgent).not.toHaveBeenCalled()
	host.child.metadata['limitless.unit'] = {
		sessionID: childID,
		worktree: childDirectory,
		directory: childDirectory,
		initializeModel: true,
	}
	host.child.agent = 'research'
	await host.prompt()
	expect(host.readAgent).not.toHaveBeenCalled()
})

test('continuations reuse placement and keep native ownership checks', async () => {
	const host = await harness()
	await Effect.runPromise(host.run())
	await host.prompt()
	await Effect.runPromise(host.run({ ...input, sessionID: childID }))
	expect(host.createWorktree).toHaveBeenCalledOnce()
	expect(host.nativePrompt).toHaveBeenCalledTimes(2)
	host.child.metadata = {}
	await expect(Effect.runPromise(host.run({ ...input, sessionID: childID }))).rejects.toThrow(
		'no completed worktree placement',
	)
	expect(host.nativePrompt).toHaveBeenCalledTimes(2)
})

test('tool replay decorates once and ordinary subagents remain native', async () => {
	const host = await harness()
	host.replay()
	host.replay()
	const args = { ...input, agent: 'research' }
	await Effect.runPromise(host.run(args))
	expect(host.nativeExecute).toHaveBeenCalledExactlyOnceWith(args, host.context)
	expect(host.createWorktree).not.toHaveBeenCalled()
	expect(host.current().description.match(/OpenCode-managed/g)).toHaveLength(1)
	expect(host.native.execute).toBe(host.nativeExecute)
})

test('unsupported versions stop Unit dispatch before native execution', async () => {
	const host = await harness('2.0.32')
	await expect(Effect.runPromise(host.run())).rejects.toThrow('requires OpenCode 2.1.4')
	expect(host.nativeExecute).not.toHaveBeenCalled()
	expect(host.createWorktree).not.toHaveBeenCalled()
	await Effect.runPromise(host.run({ ...input, agent: 'research' }))
	expect(host.nativeExecute).toHaveBeenCalledOnce()
})

test('failed provisioning retains the child identity and never admits its prompt', async () => {
	const host = await harness()
	host.createWorktree.mockImplementation(() =>
		Effect.fail(new Tool.Error({ message: 'Setup command failed' })),
	)
	await expect(Effect.runPromise(host.run())).rejects.toThrow(
		`Unit worktree setup failed (sessionID: ${childID})`,
	)
	await expect(Effect.runPromise(host.run())).rejects.toThrow('Setup command failed')
	expect(host.progress).toHaveBeenCalledWith({ sessionID: childID, status: 'running' })
	expect(host.nativePrompt).not.toHaveBeenCalled()
	await expect(Effect.runPromise(host.run({ ...input, sessionID: childID }))).rejects.toThrow(
		'no completed worktree placement',
	)
	expect(host.createWorktree).toHaveBeenCalledTimes(2)
})

test('cancelled provisioning does not reach native prompt admission', async () => {
	const host = await harness()
	let entered: (() => void) | undefined
	const waiting = new Promise<void>((resolve) => {
		entered = resolve
	})
	host.createWorktree.mockImplementation(() =>
		Effect.sync(() => entered?.()).pipe(Effect.andThen(Effect.never)),
	)
	const fiber = Effect.runFork(host.run())
	await waiting
	await Effect.runPromise(Fiber.interrupt(fiber))
	expect(host.nativePrompt).not.toHaveBeenCalled()
	expect(host.progress).toHaveBeenCalledWith({ sessionID: childID, status: 'running' })
})
