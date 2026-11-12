import type { Effect } from 'effect'

export interface NativeWorkspace {
	readonly id: string
	readonly provider: string
	/** `null` until the workspace has been provisioned. */
	readonly binding: Readonly<Record<string, unknown>> | null
}

export interface NativeSession {
	readonly id: string
	readonly location: { readonly directory: string; readonly workspaceID?: string | undefined }
	readonly agent?: string | undefined
	readonly metadata?: Readonly<Record<string, unknown>> | undefined
	readonly parentID?: string | undefined
	readonly fork?: unknown
}

/**
 * The native OpenCode services a Capsule host drives. Reads must not provision, connect, or create
 * anything, and return `undefined` for an absent resource. The host treats any failure as transient
 * unavailability and classifies conflicts by reading state again, so a bridge may pass native
 * errors through unchanged.
 */
export interface NativePorts {
	readonly workspaces: {
		/** Commits the logical workspace without provider work; idempotent for the same provider. */
		readonly create: (input: {
			readonly id: string
			readonly provider: string
		}) => Effect.Effect<unknown, unknown>
		readonly get: (id: string) => Effect.Effect<NativeWorkspace | undefined, unknown>
		readonly provision: (id: string) => Effect.Effect<NativeWorkspace, unknown>
	}
	readonly sessions: {
		readonly get: (id: string) => Effect.Effect<NativeSession | undefined, unknown>
		readonly create: (input: {
			readonly id: string
			readonly location: { readonly directory: string; readonly workspaceID: string }
			readonly agent: string
			readonly metadata: Readonly<Record<string, unknown>>
		}) => Effect.Effect<NativeSession, unknown>
	}
}
