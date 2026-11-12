import { NodeServices } from '@effect/platform-node'
import {
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Path,
	PlatformError,
	Schema,
	Scope,
} from 'effect'
import { ChildProcess, type ChildProcessSpawner } from 'effect/process'
import { describe, expect, it } from 'vitest'
import { type CapsuleSpec, RuntimeSettings } from '../schema'
import { make } from '../service'

const runtimeConfig = process.env.CAPSULE_TEST_RUNTIME

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices>) =>
	Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

const sh = (script: string) => ChildProcess.make('/bin/sh', ['-c', script])

// Stands in for `nix develop … --command …` inside the mounted checkout: it exports the
// fixture's project variable, writes noise to stdout and stderr, and runs the transport
// command. It exercises Bubblewrap, the descriptor capture, and caching, not Nix itself.
const fakeNix = (control: string) => `#!/bin/sh
while [ "$#" -gt 0 ]; do
	if [ "$1" = --command ]; then shift; break; fi
	shift
done
if [ -e '${control}/fail-nix' ]; then exit 1; fi
IFS= read -r PROJECT_VAR < '${control}/project-var'
export PROJECT_VAR
printf 'shell hook noise\\nNOISE=stdout\\0\\n'
printf 'stderr noise\\n' >&2
exec "$@"
`

const makeFixture = Effect.fn('makeFixture')(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	yield* fs.makeDirectory('/tmp/opencode', { recursive: true })
	const base = yield* fs.realPath(
		yield* fs.makeTempDirectoryScoped({ directory: '/tmp/opencode', prefix: 'capsule-service-' }),
	)
	const root = path.join(base, 'state')
	const checkout = path.join(base, 'checkout')
	const control = path.join(checkout, '.capsule-test')
	yield* fs.makeDirectory(control, { recursive: true })
	yield* fs.writeFileString(path.join(control, 'nix'), fakeNix(control))
	yield* fs.chmod(path.join(control, 'nix'), 0o755)

	const json = yield* fs.readFileString(runtimeConfig ?? '')
	const settings = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeSettings))(json)
	const runtime = { ...settings, nix: path.join(control, 'nix') }
	const capsule = yield* make({ root, runtime })

	const spec: CapsuleSpec = {
		id: 'alpha',
		directory: checkout,
		project: {
			setup: [
				'/bin/sh',
				'-c',
				'printenv PROJECT_VAR >/dev/null && echo setup-with-env >> .capsule-test/lifecycle; test ! -e .capsule-test/fail-setup',
			],
			stop: ['/bin/sh', '-c', 'echo stop >> .capsule-test/lifecycle'],
			purge: ['/bin/sh', '-c', 'echo purge >> .capsule-test/lifecycle'],
		},
	}
	const setProjectVar = (value: string) =>
		fs.writeFileString(path.join(control, 'project-var'), `${value}\n`)
	const lifecycle = fs.readFileString(path.join(control, 'lifecycle')).pipe(
		Effect.map((text) => text.trim().split('\n')),
		Effect.orElseSucceed(() => []),
	)
	const owned = path.join(root, spec.id)
	yield* setProjectVar('initial-project-secret')
	return {
		fs,
		path,
		base,
		root,
		checkout,
		control,
		owned,
		capsule,
		spec,
		runtime,
		setProjectVar,
		lifecycle,
	}
})

const output = (spawner: ChildProcessSpawner.ChildProcessSpawner['Service'], script: string) =>
	spawner.string(sh(script))

describe.skipIf(runtimeConfig === undefined)(
	'Capsule service with Bubblewrap (CAPSULE_TEST_RUNTIME)',
	() => {
		it(
			'prepares once, keeps the captured environment in memory, and refreshes cached spawners',
			{ timeout: 60_000 },
			() =>
				run(
					Effect.gen(function* () {
						const { fs, path, root, owned, capsule, spec, setProjectVar, lifecycle } =
							yield* makeFixture()

						const first = yield* capsule.prepare(spec)
						const again = yield* capsule.prepare(spec)
						expect(first).toMatchObject({ phase: 'ready', generation: 1 })
						expect(again).toEqual(first)
						expect(yield* lifecycle).toEqual(['setup-with-env'])

						const spawner = yield* capsule.connect(spec.id)
						const environment = yield* output(
							spawner,
							'printenv PROJECT_VAR CAPSULE_STATE_DIR HOME; printenv NOISE || echo unset',
						)
						expect(environment.trim().split('\n')).toEqual([
							'initial-project-secret',
							path.join(owned, 'home', '.local', 'state', 'capsule'),
							path.join(owned, 'home'),
							'unset',
						])

						yield* setProjectVar('refreshed-project-secret')
						const refreshed = yield* capsule.prepare(spec, true)
						expect(refreshed).toMatchObject({ phase: 'ready', generation: 2 })
						expect(yield* lifecycle).toEqual(['setup-with-env', 'setup-with-env'])
						expect(yield* output(spawner, 'printf %s "$PROJECT_VAR"')).toBe(
							'refreshed-project-secret',
						)

						const files = yield* fs.readDirectory(root, { recursive: true })
						for (const file of files) {
							const location = path.join(root, file)
							if ((yield* fs.stat(location)).type !== 'File') continue
							expect(yield* fs.readFileString(location)).not.toMatch(/project-secret/)
						}
					}),
				),
		)

		it(
			'retries an interrupted initial manifest publication without adopting unrelated data',
			{ timeout: 60_000 },
			() =>
				run(
					Effect.gen(function* () {
						const { fs, path, root, owned, capsule, spec, runtime, lifecycle } =
							yield* makeFixture()
						const interrupted = yield* make({ root, runtime }).pipe(
							Effect.provideService(
								FileSystem.FileSystem,
								FileSystem.FileSystem.of({
									...fs,
									rename: (from, to) => {
										if (to === path.join(owned, 'manifest.json')) {
											return Effect.fail(
												PlatformError.systemError({
													_tag: 'Busy',
													module: 'CapsuleFixture',
													method: 'rename',
												}),
											)
										}
										return fs.rename(from, to)
									},
								}),
							),
						)
						expect(yield* Effect.flip(interrupted.prepare(spec))).toMatchObject({
							_tag: 'PlatformError',
						})
						expect(yield* fs.readDirectory(owned)).toEqual([])
						expect(yield* capsule.inspect(spec.id)).toBeUndefined()
						expect(yield* lifecycle).toEqual([])
						expect(yield* capsule.prepare(spec)).toMatchObject({ phase: 'ready', spec })
						expect(yield* lifecycle).toEqual(['setup-with-env'])
					}),
				),
		)

		it('keeps a failed setup under its identity and reruns it on retry', { timeout: 60_000 }, () =>
			run(
				Effect.gen(function* () {
					const { fs, path, control, capsule, spec, lifecycle } = yield* makeFixture()
					yield* fs.writeFileString(path.join(control, 'fail-setup'), '')

					const failure = yield* Effect.flip(capsule.prepare(spec))
					expect(failure).toMatchObject({ _tag: 'CapsuleError', code: 'bootstrap_failed' })
					expect(yield* capsule.inspect(spec.id)).toMatchObject({ phase: 'preparing', spec })
					expect(yield* Effect.flip(capsule.connect(spec.id))).toMatchObject({
						code: 'not_prepared',
					})
					const other = { ...spec, project: { setup: ['/bin/sh', '-c', 'true'] } }
					expect(yield* Effect.flip(capsule.prepare(other))).toMatchObject({
						code: 'ownership_mismatch',
					})

					yield* fs.remove(path.join(control, 'fail-setup'))
					expect(yield* capsule.prepare(spec)).toMatchObject({ phase: 'ready' })
					expect(yield* lifecycle).toEqual(['setup-with-env', 'setup-with-env'])
				}),
			),
		)

		it(
			'stops without losing data, refuses execution until prepared, and resumes cached spawners',
			{ timeout: 60_000 },
			() =>
				run(
					Effect.gen(function* () {
						const { fs, path, control, owned, capsule, spec, lifecycle } = yield* makeFixture()
						yield* capsule.prepare(spec)
						const spawner = yield* capsule.connect(spec.id)
						yield* output(spawner, 'echo retained > "$CAPSULE_STATE_DIR/marker"')

						expect(yield* capsule.stop(spec.id)).toMatchObject({ phase: 'stopped' })
						expect(yield* lifecycle).toEqual(['setup-with-env', 'stop'])
						const marker = path.join(owned, 'home', '.local', 'state', 'capsule', 'marker')
						expect(yield* fs.readFileString(marker)).toBe('retained\n')
						expect(yield* Effect.flip(capsule.connect(spec.id))).toMatchObject({
							code: 'not_prepared',
						})

						// Refused spawns run in this test's still-open scope; they must not keep the
						// lifecycle lease that prepare needs.
						const refused = yield* Effect.flip(spawner.spawn(sh('echo ran')))
						expect(refused).toMatchObject({
							_tag: 'PlatformError',
							cause: { code: 'not_prepared' },
						})
						expect(yield* capsule.prepare(spec)).toMatchObject({ phase: 'ready' })

						yield* fs.writeFileString(path.join(control, 'fail-nix'), '')
						const failedRefresh = yield* Effect.flip(spawner.spawn(sh('echo ran')))
						expect(failedRefresh).toMatchObject({
							_tag: 'PlatformError',
							cause: { code: 'environment_failed' },
						})
						yield* fs.remove(path.join(control, 'fail-nix'))
						expect(yield* capsule.prepare(spec, true)).toMatchObject({ phase: 'ready' })
						expect(yield* output(spawner, 'cat "$CAPSULE_STATE_DIR/marker"')).toBe('retained\n')
					}),
				),
		)

		it(
			'stops and purges without reloading the shell when no lifecycle hooks are declared',
			{ timeout: 60_000 },
			() =>
				run(
					Effect.gen(function* () {
						const { fs, path, control, capsule, spec } = yield* makeFixture()
						yield* capsule.prepare({ ...spec, project: {} })
						yield* fs.writeFileString(path.join(control, 'fail-nix'), '')
						expect(yield* capsule.stop(spec.id)).toMatchObject({ phase: 'stopped' })
						expect(yield* capsule.purge(spec.id)).toMatchObject({ phase: 'purged' })
					}),
				),
		)

		it('purges owned state, keeps the source, and retires the identity', { timeout: 60_000 }, () =>
			run(
				Effect.gen(function* () {
					const { fs, path, checkout, owned, capsule, spec, lifecycle } = yield* makeFixture()
					yield* fs.writeFileString(path.join(checkout, 'source.txt'), 'source\n')
					yield* capsule.prepare(spec)
					const spawner = yield* capsule.connect(spec.id)
					yield* output(
						spawner,
						'touch "$HOME/home-file" "$TMPDIR/tmp-file" "$XDG_RUNTIME_DIR/run-file" "$CAPSULE_STATE_DIR/data-file"',
					)

					expect(yield* capsule.purge(spec.id)).toMatchObject({ phase: 'purged' })
					expect(yield* lifecycle).toEqual(['setup-with-env', 'stop', 'purge'])
					expect(yield* fs.readFileString(path.join(checkout, 'source.txt'))).toBe('source\n')
					for (const directory of ['home', 'tmp', 'run']) {
						expect(yield* fs.exists(path.join(owned, directory))).toBe(false)
					}

					expect(yield* capsule.inspect(spec.id)).toMatchObject({ phase: 'purged' })
					expect(yield* capsule.purge(spec.id)).toMatchObject({ phase: 'purged' })
					expect(yield* Effect.flip(capsule.prepare(spec))).toMatchObject({ code: 'not_prepared' })
					expect(yield* Effect.flip(capsule.connect(spec.id))).toMatchObject({
						code: 'not_prepared',
					})
					expect(yield* Effect.flip(output(spawner, 'echo ran'))).toMatchObject({
						_tag: 'PlatformError',
					})
				}),
			),
		)

		it(
			'resumes interrupted deletion without reloading a removed home or repeating service teardown',
			{ timeout: 60_000 },
			() =>
				run(
					Effect.gen(function* () {
						const { fs, path, root, owned, capsule, spec, runtime, lifecycle } =
							yield* makeFixture()
						yield* capsule.prepare(spec)
						const interrupted = yield* make({ root, runtime }).pipe(
							Effect.provideService(
								FileSystem.FileSystem,
								FileSystem.FileSystem.of({
									...fs,
									remove: (file, options) => {
										if (file === path.join(owned, 'tmp')) {
											return Effect.fail(
												PlatformError.systemError({
													_tag: 'Busy',
													module: 'CapsuleFixture',
													method: 'remove',
												}),
											)
										}
										return fs.remove(file, options)
									},
								}),
							),
						)
						expect(yield* Effect.flip(interrupted.purge(spec.id))).toMatchObject({
							_tag: 'PlatformError',
						})
						expect(yield* fs.exists(path.join(owned, 'home'))).toBe(false)
						expect(yield* capsule.inspect(spec.id)).toMatchObject({ phase: 'removing' })
						expect(yield* lifecycle).toEqual(['setup-with-env', 'stop', 'purge'])
						expect(yield* capsule.purge(spec.id)).toMatchObject({ phase: 'purged' })
						expect(yield* lifecycle).toEqual(['setup-with-env', 'stop', 'purge'])
						expect(yield* fs.exists(spec.directory)).toBe(true)
					}),
				),
		)

		it('blocks stop and purge while an execution is active', { timeout: 60_000 }, () =>
			run(
				Effect.gen(function* () {
					const { capsule, spec } = yield* makeFixture()
					yield* capsule.prepare(spec)
					const spawner = yield* capsule.connect(spec.id)
					const waitForInput = sh('read _')

					const execution = yield* Scope.make()
					yield* spawner.spawn(waitForInput).pipe(Scope.provide(execution))
					expect(yield* Effect.flip(capsule.stop(spec.id))).toMatchObject({ _tag: 'LockBusy' })
					expect(yield* Effect.flip(capsule.purge(spec.id))).toMatchObject({ _tag: 'LockBusy' })
					expect(yield* capsule.inspect(spec.id)).toMatchObject({ phase: 'ready' })
					yield* Scope.close(execution, Exit.void)
					expect(yield* capsule.stop(spec.id)).toMatchObject({ phase: 'stopped' })

					yield* capsule.prepare(spec)
					const started = yield* Deferred.make<void>()
					const fiber = yield* Effect.forkChild(
						Effect.scoped(
							Effect.gen(function* () {
								const handle = yield* spawner.spawn(waitForInput)
								yield* Deferred.succeed(started, undefined)
								return yield* handle.exitCode
							}),
						),
					)
					yield* Deferred.await(started)
					expect(yield* Effect.flip(capsule.purge(spec.id))).toMatchObject({ _tag: 'LockBusy' })
					yield* Fiber.interrupt(fiber)
					expect(yield* capsule.purge(spec.id)).toMatchObject({ phase: 'purged' })
				}),
			),
		)

		it('rejects overlapping state and mismatched identities', { timeout: 60_000 }, () =>
			run(
				Effect.gen(function* () {
					const { fs, path, base, root, owned, capsule, spec } = yield* makeFixture()
					yield* capsule.prepare(spec)

					const nested = path.join(root, 'nested')
					yield* fs.makeDirectory(nested)
					yield* fs.symlink(nested, path.join(base, 'linked-state'))
					for (const directory of [root, nested, base, path.join(base, 'linked-state')]) {
						expect(
							yield* Effect.flip(capsule.prepare({ ...spec, id: 'other', directory })),
						).toMatchObject({
							code: 'unsafe_path',
						})
					}

					const manifest = path.join(owned, 'manifest.json')
					yield* fs.makeDirectory(path.join(root, 'copied'))
					yield* fs.copyFile(manifest, path.join(root, 'copied', 'manifest.json'))
					yield* fs.symlink(owned, path.join(root, 'linked'))
					yield* fs.makeDirectory(path.join(root, 'linked-manifest'))
					yield* fs.symlink(manifest, path.join(root, 'linked-manifest', 'manifest.json'))
					yield* fs.makeDirectory(path.join(root, 'unowned'))
					yield* fs.writeFileString(path.join(root, 'unowned', 'file'), '')
					expect(yield* Effect.flip(capsule.inspect('copied'))).toMatchObject({
						code: 'ownership_mismatch',
					})
					expect(yield* Effect.flip(capsule.inspect('linked'))).toMatchObject({
						code: 'unsafe_path',
					})
					expect(yield* Effect.flip(capsule.inspect('linked-manifest'))).toMatchObject({
						code: 'unsafe_path',
					})
					expect(yield* Effect.flip(capsule.inspect('unowned'))).toMatchObject({
						code: 'ownership_mismatch',
					})
					expect(yield* capsule.inspect(spec.id)).toMatchObject({ phase: 'ready', spec })
				}),
			),
		)
	},
)
