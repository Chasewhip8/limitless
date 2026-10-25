import type { Backend } from '../bridge/backend'
import { startBridge } from '../bridge/server'
import { routePaseoRequest } from './rewrites'

export const paseoClient = { client: 'Paseo', route: routePaseoRequest } as const

/** Promise-facing bridge for JavaScript callers such as integration tests. */
export const startPaseoBridge = (options: {
	readonly password: string
	readonly backend: () => Promise<Backend>
}) => startBridge({ ...paseoClient, ...options })
