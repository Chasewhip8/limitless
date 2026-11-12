import { Schema } from 'effect'
import { CapsuleId } from '../identity'

export const Repository = Schema.String.check(
	Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/),
	Schema.isMaxLength(240),
).annotate({ description: 'GitHub repository as owner/name.' })

export const CommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))

const refName =
	/^(?![-/])(?!@$)(?!.*\.\.)(?!.*@\{)(?!.*\/\/)(?!.*(?:^|\/)\.)(?!.*\.lock(?:\/|$))(?!.*[./]$)[^\p{Cc}\s~^:?*[\\]+$/u

export const RefName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(240),
	Schema.isPattern(refName),
)

export const RemoteRef = Schema.Struct({
	repository: Repository,
	ref: RefName.check(Schema.isPattern(/^refs\//)),
	commit: CommitSha,
}).annotate({
	description:
		'A remote ref that must point at the commit before cloning and again before publishing.',
})
export type RemoteRef = typeof RemoteRef.Type

export const SourceSpec = Schema.Struct({
	repository: Repository.annotate({
		description: 'Repository cloned as origin, which is also its push URL.',
	}),
	ref: RefName.annotate({
		description: 'Branch, tag, or full commit SHA, resolved once when the source is first created.',
	}),
	branch: RefName.annotate({ description: 'Local branch checked out at the resolved commit.' }),
	commit: Schema.optionalKey(
		CommitSha.annotate({ description: 'Commit the ref must resolve to when first created.' }),
	),
	upstream: Schema.optionalKey(
		Schema.Struct({
			repository: Repository,
			commits: Schema.Array(CommitSha).annotate({
				description: 'Commits fetched from upstream that must exist in the clone.',
			}),
		}).annotate({ description: 'Repository configured as the upstream remote.' }),
	),
	remoteRefs: Schema.optionalKey(Schema.Array(RemoteRef)),
})
export type SourceSpec = typeof SourceSpec.Type

export const SourceRequest = Schema.Struct({
	id: CapsuleId,
	...SourceSpec.fields,
}).annotate({
	description:
		'Identifies a retained source checkout. Preparing an existing id requires an identical request.',
})
export type SourceRequest = typeof SourceRequest.Type

export const Resolved = Schema.Struct({
	kind: Schema.Literals(['branch', 'tag', 'commit']),
	commit: CommitSha,
})
export type Resolved = typeof Resolved.Type

export const ArchiveMetadata = Schema.Struct({
	path: Schema.String,
	sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
	bytes: Schema.Int.check(Schema.isGreaterThan(0)),
})
export type ArchiveMetadata = typeof ArchiveMetadata.Type

const identity = { id: CapsuleId, directory: Schema.String }
export const SourceStatus = Schema.Union([
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
export type SourceStatus = typeof SourceStatus.Type

export const PreparedSource = Schema.Struct({
	id: CapsuleId,
	directory: Schema.String,
	branch: RefName.annotate({
		description: 'Initial local branch; resumption preserves subsequent user branch changes.',
	}),
	commit: CommitSha.annotate({ description: 'Commit the ref resolved to at creation.' }),
})
export type PreparedSource = typeof PreparedSource.Type

export class SourceError extends Schema.TaggedError<SourceError>()('SourceError', {
	code: Schema.Literals([
		'invalid_input',
		'input_collision',
		'illegal_transition',
		'unsafe_path',
		'ownership_mismatch',
		'busy',
		'unknown_ref',
		'stale_ref',
		'git_failed',
		'archive_failed',
		'archive_changed',
		'io_failed',
		'invalid_manifest',
	]),
	message: Schema.String,
}) {}
