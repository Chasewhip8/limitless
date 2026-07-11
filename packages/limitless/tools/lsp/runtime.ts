import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Deferred, Queue, Ref, Semaphore } from 'effect'
import type { LspServerConfig } from './config'
import type { LspToolError } from './errors'
import type { JsonRpcId, LspServerCapabilities } from './schema'

export type LspPendingRequest = {
	readonly tool: string
	readonly method: string
	readonly deferred: Deferred.Deferred<unknown, LspToolError>
}

export type LspRuntimeState = {
	readonly closed: boolean
	readonly nextId: number
	readonly pending: ReadonlyMap<JsonRpcId, LspPendingRequest>
	readonly stderr: string
}

export type LspRuntimeEvent =
	| { readonly _tag: 'stdout'; readonly chunk: Buffer }
	| { readonly _tag: 'stderr'; readonly chunk: Buffer }
	| { readonly _tag: 'close'; readonly code: number | null; readonly signal: NodeJS.Signals | null }
	| {
			readonly _tag: 'error'
			readonly source: 'process' | 'stdin' | 'stdout' | 'stderr'
			readonly error: Error
	  }

export type LspConnectionRuntime = {
	readonly config: LspServerConfig
	readonly workspace: string
	readonly process: ChildProcessWithoutNullStreams
	readonly state: Ref.Ref<LspRuntimeState>
	readonly capabilities: Ref.Ref<LspServerCapabilities>
	readonly events: Queue.Queue<LspRuntimeEvent>
	readonly processClosed: Deferred.Deferred<void>
	readonly eventsDrained: Deferred.Deferred<void>
	readonly writes: Semaphore.Semaphore
	readonly onStdout: (chunk: Buffer) => void
	readonly onStderr: (chunk: Buffer) => void
	readonly onClose: (code: number | null, signal: NodeJS.Signals | null) => void
	readonly onProcessError: (error: Error) => void
	readonly onStdinError: (error: Error) => void
	readonly onStdoutError: (error: Error) => void
	readonly onStderrError: (error: Error) => void
}
