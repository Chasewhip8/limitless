import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Deferred, Ref } from 'effect'
import type { Disposable, ProtocolConnection } from 'vscode-languageserver-protocol/node'
import type { LspServerConfig } from './config'
import type { LspServerCapabilities } from './schema'

export type LspRuntimeState = {
	readonly closed: boolean
	readonly stderr: string
	readonly failure: string | undefined
}

export type LspConnectionRuntime = {
	readonly config: LspServerConfig
	readonly workspace: string
	readonly process: ChildProcessWithoutNullStreams
	readonly protocol: ProtocolConnection
	readonly state: Ref.Ref<LspRuntimeState>
	readonly capabilities: Ref.Ref<LspServerCapabilities>
	readonly transportFailed: Deferred.Deferred<void>
	readonly processClosed: Deferred.Deferred<void>
	readonly protocolDisposables: ReadonlyArray<Disposable>
	readonly onStderr: (chunk: Buffer) => void
	readonly onProcessClose: (code: number | null, signal: NodeJS.Signals | null) => void
	readonly onProcessError: (error: Error) => void
	readonly onStderrError: (error: Error) => void
}
