import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { afterEach, expect, test, vi } from 'vitest'
import { managedBackend, ServiceBackend } from '../bridge/backend'

const directories: string[] = []

afterEach(async () => {
	vi.unstubAllEnvs()
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	)
})

test('an absent managed service is a 502 that launchers may wait out', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'limitless-no-service-'))
	directories.push(directory)
	vi.stubEnv('XDG_STATE_HOME', directory)
	const error = await Effect.runPromise(
		Effect.gen(function* () {
			return yield* (yield* ServiceBackend).resolve
		}).pipe(Effect.flip, Effect.provide(managedBackend.pipe(Layer.provide(NodeServices.layer)))),
	)
	// OpenCode's client, which T3 uses, reads 503 bodies as JSON; the wire status stays 502.
	expect(error).toMatchObject({
		_tag: 'BridgeError',
		status: 502,
		unavailable: true,
		message: 'The managed OpenCode service is unavailable; start it before connecting',
	})
})
