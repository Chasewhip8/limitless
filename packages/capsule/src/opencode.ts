import { WorkspaceDriver } from '@opencode/sdk/effect'
import { Effect } from 'effect'
import { makeDriver } from './workspace'

/** Requires `Capsule`; each workspace attaches to a ready Capsule already prepared under its ID. */
export const make = Effect.fn('CapsuleWorkspace.make')(function* () {
	const driver = yield* makeDriver((message) => WorkspaceDriver.Error.make({ message }))
	return WorkspaceDriver.make(driver)
})
