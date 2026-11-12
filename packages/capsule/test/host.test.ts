import { NodeServices } from '@effect/platform-node'
import type { Plugin } from '@opencode/plugin/effect'
import { Effect, type FileSystem, type Path, type Scope } from 'effect'
import { describe, expect, it } from 'vitest'
import { makePlugin } from '../src/host'
import type { PrepareSession } from '../src/host/contract'
import { resolveSettings } from '../src/host/roots'
import { make as makeHost } from '../src/host/service'
import { makeNativeHost, makeRoots } from './fixtures/native-host'

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem | Path.Path>) =>
	Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

const workspaceId = 'wrk_fixture'
const sessionId = 'ses_fixture'
const owner = { namespace: 'pipeline', id: 'task-1' }
const source = { repository: 'fixture/project', ref: 'main', branch: 'work' }

const setup = Effect.gen(function* () {
	const { settings } = yield* makeRoots
	const native = yield* makeNativeHost(settings)
	const request: PrepareSession = {
		storageId: native.host.info.storageId,
		workspaceId,
		sessionId,
		owner,
		source,
		agent: 'build',
		metadata: { task: 'one' },
	}
	const reference = { storageId: request.storageId, workspaceId, sessionId, owner }
	return { ...native, request, reference }
})

type Handlers = Readonly<
	Record<string, (input: unknown, context: unknown) => Effect.Effect<unknown, unknown>>
>

/** Activates `plugin` like OpenCode at each location, recording the RPC services it registers. */
const pluginActivations = (plugin: Plugin.Plugin) => {
	const registrations: Array<{ readonly id: string; readonly handlers: Handlers }> = []
	const activate = (location: { readonly directory: string; readonly workspaceID?: string }) =>
		plugin.effect({
			location,
			rpc: {
				register: (definition: { readonly id: string }, handlers: Handlers) =>
					Effect.sync(() => {
						registrations.push({ id: definition.id, handlers })
					}),
			},
		} as unknown as Plugin.Context)
	return { registrations, activate }
}

const rejection = <A>(effect: Effect.Effect<A, { readonly code: string }>) =>
	Effect.map(Effect.flip(effect), ({ code }) => code)

describe('Capsule host settings', () => {
	it('fingerprints canonical storage roots and keeps the control directory separate', () =>
		run(
			Effect.gen(function* () {
				const { fs, at, settings } = yield* makeRoots
				yield* fs.makeDirectory(at('real'))
				yield* fs.symlink(at('real'), at('link'))
				const linked = { ...settings, checkoutRoot: at('link', 'checkouts') }

				const resolved = yield* resolveSettings(linked)
				expect(resolved.checkoutRoot).toBe(at('real', 'checkouts'))
				expect(yield* fs.exists(resolved.controlDirectory)).toBe(true)
				const { host } = yield* makeNativeHost(linked)
				const { host: same } = yield* makeNativeHost(resolved)
				const { host: other } = yield* makeNativeHost({
					...settings,
					checkoutRoot: at('other'),
				})
				expect(host.info).toEqual({
					version: 1,
					storageId: same.info.storageId,
					checkoutRoot: at('real', 'checkouts'),
				})
				expect(other.info.storageId).not.toBe(host.info.storageId)

				// The Capsule must be built from the same canonical roots the host reports.
				const unresolved = makeHost(linked, undefined as never, undefined as never)
				expect(yield* Effect.flip(unresolved)).toMatchObject({ code: 'unsafe_path' })
				for (const controlDirectory of [at('runtime', 'control'), settings.checkoutRoot]) {
					const overlapping = resolveSettings({ ...settings, controlDirectory })
					expect(yield* Effect.flip(overlapping)).toMatchObject({ code: 'unsafe_path' })
				}
			}),
		))

	// OpenCode normalizes Location paths without resolving symlinks, so the host serves exactly the
	// declared control address while checking the physical directory behind it for overlap.
	it('serves the declared control address of a symlinked control directory', () =>
		run(
			Effect.gen(function* () {
				const { fs, at, settings } = yield* makeRoots
				yield* fs.makeDirectory(at('control-target'))
				yield* fs.symlink(at('control-target'), at('control-alias'))

				const resolved = yield* resolveSettings({
					...settings,
					controlDirectory: `${at('control-alias')}/.`,
				})
				expect(resolved.controlDirectory).toBe(at('control-alias'))
				const { host } = yield* makeNativeHost(resolved)
				const { registrations, activate } = pluginActivations(
					makePlugin(host, resolved.controlDirectory),
				)
				yield* activate({ directory: at('control-target') })
				expect(registrations).toEqual([])
				yield* activate({ directory: at('control-alias') })
				expect(registrations.map(({ id }) => id)).toEqual(['capsule'])

				yield* fs.makeDirectory(at('runtime', 'nested'), { recursive: true })
				yield* fs.makeDirectory(at('checkouts'), { recursive: true })
				yield* fs.symlink(at('runtime', 'nested'), at('into-runtime'))
				yield* fs.symlink(at('checkouts'), at('into-checkouts'))
				for (const alias of [at('into-runtime'), at('into-checkouts')]) {
					const overlapping = resolveSettings({ ...settings, controlDirectory: alias })
					expect(yield* Effect.flip(overlapping)).toMatchObject({ code: 'unsafe_path' })
				}
			}),
		))
})

describe('Capsule host sessions', () => {
	it('claims the workspace before preparing the Capsule, then binds the session to it', () =>
		run(
			Effect.gen(function* () {
				const { host, request, reference, operations, sessions, settings } = yield* setup
				const directory = `${settings.checkoutRoot}/${workspaceId}/checkout`

				expect(yield* host.prepareSession(request)).toEqual({ workspaceId, sessionId, directory })
				expect(operations).toEqual([
					'workspace.create',
					'capsule.create',
					'workspace.provision',
					'session.create',
				])
				expect(sessions.get(sessionId)).toEqual({
					id: sessionId,
					location: { directory, workspaceID: workspaceId },
					agent: 'build',
					metadata: { task: 'one', capsule: { owner, agent: 'build' } },
				})
				expect(yield* host.getSession(reference)).toEqual({
					workspaceId,
					sessionId,
					directory,
					capsulePhase: 'ready',
					workspaceState: 'bound',
				})
			}),
		))

	it('answers retries and lookups of a prepared session without side effects', () =>
		run(
			Effect.gen(function* () {
				const { host, request, reference, operations, sessions } = yield* setup
				const prepared = yield* host.prepareSession(request)
				operations.length = 0

				expect(yield* host.prepareSession({ ...request, metadata: { task: 'retry' } })).toEqual(
					prepared,
				)
				// Agent and descriptive metadata belong to the session once it exists.
				const session = sessions.get(sessionId)
				if (!session) throw new Error('Expected the prepared session')
				sessions.set(sessionId, {
					...session,
					agent: 'plan',
					metadata: { ...session.metadata, task: 'edited' },
				})
				expect(yield* host.getSession(reference)).toMatchObject(prepared)
				expect(yield* host.prepareSession(request)).toEqual(prepared)

				const other = { namespace: 'pipeline', id: 'task-2' }
				expect(yield* rejection(host.getSession({ ...reference, owner: other }))).toBe('ownership')
				expect(yield* rejection(host.prepareSession({ ...request, agent: 'plan' }))).toBe(
					'ownership',
				)
				expect(
					yield* rejection(host.prepareSession({ ...request, source: { ...source, ref: 'dev' } })),
				).toBe('ownership')
				expect(yield* rejection(host.getSession({ ...reference, sessionId: 'ses_missing' }))).toBe(
					'not_ready',
				)
				expect(operations).toEqual([])
			}),
		))

	it('refuses foreign storage, reserved metadata, and foreign workspaces before any setup', () =>
		run(
			Effect.gen(function* () {
				const { host, request, reference, operations, workspaces } = yield* setup
				workspaces.set(workspaceId, { id: workspaceId, provider: 'worktree', binding: null })

				const foreign = { ...request, storageId: 'another' }
				expect(yield* rejection(host.prepareSession(foreign))).toBe('incompatible')
				expect(yield* rejection(host.getSession({ ...reference, storageId: 'another' }))).toBe(
					'incompatible',
				)
				const reserved = { ...request, metadata: { capsule: { owner } } }
				expect(yield* rejection(host.prepareSession(reserved))).toBe('invalid_input')
				expect(yield* rejection(host.prepareSession(request))).toBe('ownership')
				expect(operations).toEqual([])
			}),
		))

	it('observes a retained session after its Capsule stops or is purged, but never revives it', () =>
		run(
			Effect.gen(function* () {
				const { host, request, reference, operations, transition } = yield* setup
				const prepared = yield* host.prepareSession(request)
				const next = { ...request, sessionId: 'ses_next' }
				operations.length = 0

				for (const phase of ['stopped', 'purged'] as const) {
					yield* transition(workspaceId, phase)
					expect(yield* host.getSession(reference)).toEqual({
						...prepared,
						capsulePhase: phase,
						workspaceState: 'bound',
					})
					expect(yield* rejection(host.prepareSession(request))).toBe('not_ready')
					expect(yield* rejection(host.prepareSession(next))).toBe('not_ready')
				}
				expect(operations).toEqual([])
			}),
		))

	it('reports a missing or unprovisioned native workspace without provisioning it', () =>
		run(
			Effect.gen(function* () {
				const { host, request, reference, operations, workspaces } = yield* setup
				yield* host.prepareSession(request)
				operations.length = 0

				workspaces.set(workspaceId, { id: workspaceId, provider: 'capsule', binding: null })
				expect(yield* host.getSession(reference)).toMatchObject({
					capsulePhase: 'ready',
					workspaceState: 'unprovisioned',
				})
				expect(yield* rejection(host.prepareSession(request))).toBe('not_ready')
				workspaces.delete(workspaceId)
				expect(yield* host.getSession(reference)).toMatchObject({ workspaceState: 'absent' })
				expect(yield* rejection(host.prepareSession(request))).toBe('not_ready')
				expect(operations).toEqual([])
			}),
		))

	it('refuses conflicting workspaces and sessions whose Capsule record is gone', () =>
		run(
			Effect.gen(function* () {
				const { host, request, reference, operations, workspaces, manifests, transition } =
					yield* setup
				yield* host.prepareSession(request)
				yield* transition(workspaceId, 'stopped')
				operations.length = 0
				const conflicts = [
					{ id: workspaceId, provider: 'worktree', binding: null },
					{ id: workspaceId, provider: 'capsule', binding: { id: workspaceId, directory: '/x' } },
				]
				for (const conflict of conflicts) {
					workspaces.set(workspaceId, conflict)
					expect(yield* rejection(host.getSession(reference))).toBe('ownership')
					expect(yield* rejection(host.prepareSession(request))).toBe('ownership')
				}
				manifests.delete(workspaceId)
				expect(yield* rejection(host.getSession(reference))).toBe('ownership')
				expect(operations).toEqual([])
			}),
		))

	it('resumes interrupted preparation and reports held locks as retryable', () =>
		run(
			Effect.gen(function* () {
				const { host, request, operations, inject } = yield* setup
				inject('capsule.create')
				expect(yield* rejection(host.prepareSession(request))).toBe('unavailable')
				inject('session.create')
				expect(yield* rejection(host.prepareSession(request))).toBe('unavailable')
				yield* host.prepareSession(request)
				expect(operations).toEqual([
					'workspace.create',
					'capsule.create',
					'capsule.create',
					'workspace.provision',
					'session.create',
					'capsule.create',
					'workspace.provision',
					'session.create',
				])
			}),
		))

	it('confirms the session OpenCode returns instead of trusting it', () =>
		run(
			Effect.gen(function* () {
				const { host, request, adoptForeignSession } = yield* setup
				adoptForeignSession()
				expect(yield* rejection(host.prepareSession(request))).toBe('ownership')
			}),
		))

	it('attaches workspaces only to Capsules prepared beforehand', () =>
		run(
			Effect.gen(function* () {
				const { driver } = yield* setup
				const error = yield* Effect.flip(driver.create({ workspaceID: workspaceId }))
				expect(error.message).toBe(
					'Capsule attach failed: Prepare the Capsule before provisioning its workspace.',
				)
			}),
		))
})

describe('Capsule host RPC', () => {
	it('registers only at the control location and declares rejections', () =>
		run(
			Effect.gen(function* () {
				const { host, reference, settings } = yield* setup
				const { registrations, activate } = pluginActivations(
					makePlugin(host, settings.controlDirectory),
				)

				yield* activate({ directory: settings.root })
				yield* activate({ directory: settings.controlDirectory, workspaceID: workspaceId })
				expect(registrations).toEqual([])
				yield* activate({ directory: settings.controlDirectory })
				const [registration] = registrations
				expect(registration?.id).toBe('capsule')

				const error = (type: string, message: string, data: unknown) => ({ type, message, data })
				const lookup = registration?.handlers.getSession?.(reference, { error })
				if (!lookup) throw new Error('Expected a getSession handler')
				expect(yield* Effect.flip(lookup)).toEqual({
					type: 'rejected',
					message: 'The session does not exist.',
					data: { code: 'not_ready' },
				})
			}),
		))
})
