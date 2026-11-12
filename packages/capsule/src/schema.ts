import { Schema } from 'effect'
import { AbsolutePath, CapsuleId, Text } from './identity'
import { CommitSha, SourceRequest } from './source/schema'

export { AbsolutePath, CapsuleId } from './identity'

const Arguments = Schema.Array(Text).check(Schema.isMinLength(1))

export const Project = Schema.Struct({
	devShell: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/))),
	setup: Schema.optionalKey(Arguments),
	stop: Schema.optionalKey(Arguments),
	purge: Schema.optionalKey(Arguments),
})
export type Project = typeof Project.Type

export const CapsuleSpec = Schema.Struct({
	id: CapsuleId,
	directory: AbsolutePath,
	project: Project,
	dockerSocket: Schema.optionalKey(AbsolutePath),
})
export type CapsuleSpec = typeof CapsuleSpec.Type

export const RuntimeSettings = Schema.Struct({
	bwrap: AbsolutePath,
	shell: AbsolutePath,
	env: AbsolutePath,
	nix: AbsolutePath,
	node: AbsolutePath,
	gh: AbsolutePath,
	flock: AbsolutePath,
	basePath: Schema.NonEmptyString,
	certificates: AbsolutePath,
})
export type RuntimeSettings = typeof RuntimeSettings.Type

export const ManagedSource = Schema.Struct({
	root: AbsolutePath,
	request: SourceRequest,
	commit: Schema.optionalKey(CommitSha),
})
export type ManagedSource = typeof ManagedSource.Type

export const Phase = Schema.Literals([
	'creating',
	'preparing',
	'ready',
	'stopping',
	'stopped',
	'purging',
	'removing',
	'purged',
])
export type Phase = typeof Phase.Type

export const Manifest = Schema.Struct({
	owner: Schema.Literal('limitless-capsule-v2'),
	spec: CapsuleSpec,
	source: Schema.optionalKey(ManagedSource),
	generation: Schema.Int.check(Schema.isGreaterThan(0)),
	phase: Phase,
}).check(
	Schema.makeFilter((manifest) => {
		if (manifest.source === undefined)
			return manifest.phase !== 'creating' || 'Creating requires a source request'
		return (
			manifest.source.request.id === manifest.spec.id ||
			'Managed source identity must match the Capsule'
		)
	}),
)
export type Manifest = typeof Manifest.Type

export class CapsuleError extends Schema.TaggedError<CapsuleError>()('CapsuleError', {
	code: Schema.Literals([
		'invalid_input',
		'unsafe_path',
		'ownership_mismatch',
		'not_prepared',
		'bootstrap_failed',
		'command_failed',
		'environment_failed',
	]),
	message: Schema.String,
}) {}
