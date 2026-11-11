import { Schema } from 'effect'

export const TaskId = Schema.String.check(
	Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
)
export const Repository = Schema.String.check(
	Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/),
	Schema.isMaxLength(240),
)
export const CommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
export const HeadRef = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(240),
	Schema.isPattern(
		/^(?![-/])(?!@$)(?!.*\.\.)(?!.*@\{)(?!.*\/\/)(?!.*(?:^|\/)\.)(?!.*\.lock(?:\/|$))(?!.*[./]$)[^\p{Cc}\s~^:?*[\\]+$/u,
	),
)
export const PrepareInput = Schema.Struct({
	taskId: TaskId,
	repository: Repository,
	sourceRepository: Repository,
	prNumber: Schema.Int.check(Schema.isGreaterThan(0)),
	headRef: HeadRef,
	headSha: CommitSha,
	baseSha: CommitSha,
})
export type PrepareInput = typeof PrepareInput.Type

export const protocolVersion = 2 as const
export const Protocol = Schema.Struct({ protocolVersion: Schema.Literal(protocolVersion) })
export const WorkspaceRequest = Schema.Union([
	Schema.Struct({ operation: Schema.Literal('prepare'), input: PrepareInput }),
	Schema.Struct({ operation: Schema.Literal('inspect'), taskId: TaskId }),
])
export type WorkspaceRequest = typeof WorkspaceRequest.Type

export const ArchiveMetadata = Schema.Struct({
	path: Schema.String,
	sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
	bytes: Schema.Int.check(Schema.isGreaterThan(0)),
})
export type ArchiveMetadata = typeof ArchiveMetadata.Type

const identity = { taskId: TaskId, directory: Schema.String }
export const WorkspaceStatus = Schema.Union([
	Schema.TaggedStruct('Absent', identity),
	Schema.TaggedStruct('Preparing', {
		...identity,
		step: Schema.Literals(['clone', 'configure', 'publish']),
	}),
	Schema.TaggedStruct('Ready', identity),
	Schema.TaggedStruct('Archiving', identity),
	Schema.TaggedStruct('Archived', { ...identity, archive: ArchiveMetadata }),
	Schema.TaggedStruct('Releasing', { ...identity, archive: ArchiveMetadata }),
	Schema.TaggedStruct('Released', { ...identity, archive: ArchiveMetadata }),
])
export type WorkspaceStatus = typeof WorkspaceStatus.Type

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()('WorkspaceError', {
	code: Schema.Literals([
		'invalid_input',
		'input_collision',
		'illegal_transition',
		'unsafe_path',
		'ownership_mismatch',
		'busy',
		'stale_head',
		'git_failed',
		'archive_failed',
		'archive_changed',
		'io_failed',
		'invalid_manifest',
	]),
	message: Schema.String,
}) {}
