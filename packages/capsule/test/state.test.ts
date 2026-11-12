import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Path } from 'effect'
import { expect, it } from 'vitest'
import { makeState } from '../src/runtime/state'
import { makeStorage } from '../src/source/storage'

const fixture = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	yield* fs.makeDirectory('/tmp/opencode', { recursive: true })
	const root = yield* fs.makeTempDirectoryScoped({
		directory: '/tmp/opencode',
		prefix: 'capsule-state-',
	})
	return { fs, path, root }
})

it('never publishes runtime metadata larger than its reader accepts', () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { fs, path, root } = yield* fixture
			const state = yield* makeState(path.join(root, 'runtime'))
			yield* state.initialize('large')
			const manifest = {
				owner: 'limitless-capsule-v2',
				generation: 1,
				phase: 'preparing',
				spec: { id: 'large', directory: path.join(root, 'checkout'), project: {} },
			} as const
			const oversized = {
				...manifest,
				spec: { ...manifest.spec, project: { setup: ['echo', 'x'.repeat(65_536)] } },
			}
			expect(yield* Effect.flip(state.write(oversized))).toMatchObject({ code: 'invalid_input' })
			expect(yield* fs.exists(state.paths('large').manifest)).toBe(false)
			expect(yield* state.read('large')).toBeUndefined()
			yield* state.write(manifest)
			expect(yield* state.read('large')).toEqual(manifest)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	))

it('never publishes source metadata larger than its reader accepts', () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { fs, path, root } = yield* fixture
			const state = yield* makeStorage(path.join(root, 'source'))
			yield* state.ensureLock('large')
			yield* state.createDirectory('large')
			const commit = 'a'.repeat(40)
			const manifest = {
				owner: 'limitless-source-v1',
				request: { id: 'large', repository: 'fixture/project', ref: 'main', branch: 'work' },
				resolved: { kind: 'branch', commit },
				status: {
					_tag: 'Preparing',
					id: 'large',
					directory: state.paths('large').checkout,
					step: 'clone',
				},
			} as const
			const oversized = {
				...manifest,
				request: {
					...manifest.request,
					remoteRefs: Array.from({ length: 500 }, () => ({
						repository: 'fixture/project',
						ref: 'refs/heads/main',
						commit,
					})),
				},
			}
			expect(yield* Effect.flip(state.write(oversized))).toMatchObject({ code: 'invalid_input' })
			expect(yield* fs.exists(state.paths('large').manifest)).toBe(false)
			expect(yield* state.read('large')).toBeUndefined()
			yield* state.write(manifest)
			expect(yield* state.read('large')).toEqual(manifest)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	))
