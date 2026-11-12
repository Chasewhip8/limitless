import type { Plugin } from '@opencode/plugin/effect'
import { Effect } from 'effect'
import { CapsuleHostRpc } from './contract'
import type { CapsuleHost } from './service'

/**
 * Serves `CapsuleHostRpc` only from the host's control location, a directory outside every
 * workspace, so clients reach it through that explicit location and never through a project.
 */
export const makePlugin = (host: CapsuleHost, controlDirectory: string): Plugin.Plugin => ({
	id: 'capsule',
	effect: Effect.fn('CapsuleHost.plugin')(function* ({ location, rpc }: Plugin.Context) {
		if (location.directory !== controlDirectory || location.workspaceID !== undefined) return
		yield* rpc
			.register(CapsuleHostRpc, {
				info: () => Effect.succeed(host.info),
				prepareSession: (input, { error }) =>
					host
						.prepareSession(input)
						.pipe(Effect.mapError(({ code, message }) => error('rejected', message, { code }))),
				getSession: (input, { error }) =>
					host
						.getSession(input)
						.pipe(Effect.mapError(({ code, message }) => error('rejected', message, { code }))),
			})
			.pipe(Effect.orDie)
	}),
})
