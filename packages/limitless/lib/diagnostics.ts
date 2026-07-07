import { Schema } from 'effect'
import type { CommandResult } from './command'

export const DiagnosticsInput = Schema.Struct({
	workspace: Schema.optional(Schema.String),
	filePath: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
})
export type DiagnosticsInput = typeof DiagnosticsInput.Type

export type SkippedCheck = {
	readonly name: string
	readonly ok: false
	readonly skipped: true
	readonly reason: string
}

export type ExecutedCheck = CommandResult & {
	readonly name: string
	readonly command: string
	readonly config: string
}

export type DiagnosticCheck = SkippedCheck | ExecutedCheck

export type DiagnosticsStatus = 'passed' | 'failed' | 'partial' | 'skipped'

export type DiagnosticsResult = {
	readonly ok: boolean
	readonly status: DiagnosticsStatus
	readonly checks: ReadonlyArray<DiagnosticCheck>
}
