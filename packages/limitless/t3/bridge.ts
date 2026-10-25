import type { Backend } from '../bridge/backend'
import { startBridge } from '../bridge/server'
import { routeT3Request } from './rewrites'

export const t3Client = { client: 'T3', route: routeT3Request } as const

/** Promise-facing bridge for JavaScript callers such as integration tests. */
export const startT3Bridge = (options: {
	/** The password T3 generated for the server it believes it spawned. */
	readonly password: string
	readonly backend: () => Promise<Backend>
	readonly hostname?: string
	readonly port?: number
}) => startBridge({ ...t3Client, ...options })
