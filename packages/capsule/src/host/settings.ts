import { Schema } from 'effect'
import { CredentialsOptions } from '../credentials'
import { AbsolutePath } from '../identity'
import { RuntimeSettings } from '../schema'

export const HostSettings = Schema.Struct({
	root: AbsolutePath,
	checkoutRoot: AbsolutePath,
	controlDirectory: AbsolutePath,
	runtime: RuntimeSettings,
	credentials: Schema.optionalKey(CredentialsOptions),
	dockerSocket: Schema.optionalKey(AbsolutePath),
})
export type HostSettings = typeof HostSettings.Type
