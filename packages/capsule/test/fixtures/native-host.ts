import { Effect, FileSystem, Path } from 'effect'
import type { NativePorts, NativeSession, NativeWorkspace } from '../../src/host'
import { makeDriver } from '../../src/host'
import { resolveSettings } from '../../src/host/roots'
import { make as makeHost } from '../../src/host/service'
import { LockBusy } from '../../src/runtime/lock'
import { CapsuleError, type Manifest } from '../../src/schema'
import { Capsule } from '../../src/service'
import type { SourceRequest } from '../../src/source/schema'

const runtime = {
	bwrap: '/fixture/bwrap',
	shell: '/fixture/sh',
	env: '/fixture/env',
	nix: '/fixture/nix',
	node: '/fixture/node',
	gh: '/fixture/gh',
	flock: '/fixture/flock',
	basePath: '/fixture/bin',
	certificates: '/fixture/certificates',
}

/** Isolated host roots under /tmp/opencode, with the directory settings a host is built from. */
export const makeRoots = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	yield* fs.makeDirectory('/tmp/opencode', { recursive: true })
	const base = yield* fs.realPath(
		yield* fs.makeTempDirectoryScoped({ directory: '/tmp/opencode', prefix: 'capsule-host-' }),
	)
	const at = (...segments: ReadonlyArray<string>) => path.join(base, ...segments)
	const settings = {
		root: at('runtime'),
		checkoutRoot: at('checkouts'),
		controlDirectory: at('control'),
		runtime,
	}
	return { fs, at, settings }
})

type Fault = 'capsule.create' | 'session.create'

/**
 * A Capsule that prepares managed sources instantly, and native workspace and session stores that
 * provision through the shared workspace driver. `operations` records every side effect, in order.
 */
export const makeNativeHost = Effect.fn('makeNativeHost')(function* (input: unknown) {
	const settings = yield* resolveSettings(input)
	const operations: Array<string> = []
	const faults = new Set<Fault>()
	const manifests = new Map<string, Manifest>()
	const workspaces = new Map<string, NativeWorkspace>()
	const sessions = new Map<string, NativeSession>()
	let adoptForeignSession = false

	const record = (operation: string) =>
		Effect.sync(() => {
			operations.push(operation)
		})
	const fault = (operation: Fault) => {
		const injected = faults.delete(operation)
		return injected
			? Effect.fail(LockBusy.make({ path: operation, mode: 'exclusive' }))
			: Effect.void
	}

	const unused = () => Effect.die('Unused by the host.')
	const capsule = Capsule.of({
		create: (request: SourceRequest) =>
			Effect.gen(function* () {
				yield* record('capsule.create')
				yield* fault('capsule.create')
				const existing = manifests.get(request.id)
				if (existing?.phase === 'ready') return existing
				const manifest: Manifest = {
					owner: 'limitless-capsule-v2',
					spec: {
						id: request.id,
						directory: `${settings.checkoutRoot}/${request.id}/checkout`,
						project: {},
					},
					source: { root: settings.checkoutRoot, request },
					generation: 1,
					phase: 'ready',
				}
				manifests.set(request.id, manifest)
				return manifest
			}),
		prepare: unused,
		inspect: (id) => Effect.sync(() => manifests.get(id)),
		connect: unused,
		stop: unused,
		purge: unused,
	})
	const driver = yield* makeDriver((message) => new Error(message)).pipe(
		Effect.provideService(Capsule, capsule),
	)

	const native: NativePorts = {
		workspaces: {
			create: ({ id, provider }) =>
				Effect.gen(function* () {
					yield* record('workspace.create')
					const existing = workspaces.get(id)
					if (existing && existing.provider !== provider) return yield* Effect.fail('conflict')
					if (!existing) workspaces.set(id, { id, provider, binding: null })
					return id
				}),
			get: (id) => Effect.sync(() => workspaces.get(id)),
			provision: (id) =>
				Effect.gen(function* () {
					yield* record('workspace.provision')
					const workspace = workspaces.get(id)
					if (!workspace) return yield* Effect.fail('not found')
					if (workspace.binding !== null) return workspace
					const { binding } = yield* driver.create({ workspaceID: id })
					const provisioned = { ...workspace, binding }
					workspaces.set(id, provisioned)
					return provisioned
				}),
		},
		sessions: {
			get: (id) => Effect.sync(() => sessions.get(id)),
			// Like OpenCode, an existing ID is adopted before the input is considered.
			create: ({ id, location, agent, metadata }) =>
				Effect.gen(function* () {
					yield* record('session.create')
					yield* fault('session.create')
					const existing = sessions.get(id)
					if (existing) return existing
					const session = adoptForeignSession
						? { id, location: { directory: '/elsewhere' } }
						: { id, location, agent, metadata }
					sessions.set(id, session)
					return session
				}),
		},
	}

	const host = yield* makeHost(settings, capsule, native)
	return {
		host,
		settings,
		operations,
		manifests,
		workspaces,
		sessions,
		driver,
		inject: (operation: Fault) => faults.add(operation),
		adoptForeignSession: () => {
			adoptForeignSession = true
		},
		/** Moves a Capsule as an operator's stop or purge would. */
		transition: (id: string, phase: 'stopped' | 'purged') =>
			Effect.gen(function* () {
				const manifest = manifests.get(id)
				if (!manifest) return yield* CapsuleError.make({ code: 'not_prepared', message: id })
				manifests.set(id, { ...manifest, phase, generation: manifest.generation + 1 })
			}),
	}
})
