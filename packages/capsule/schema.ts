import { Schema } from 'effect'

export const CapsuleId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/))
const Text = Schema.String.check(
	Schema.makeFilter((value) => !value.includes('\0') || 'Must not contain a NUL character'),
)
export const AbsolutePath = Text.check(Schema.isPattern(/^\//))
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
	flock: AbsolutePath,
	basePath: Schema.NonEmptyString,
	certificates: AbsolutePath,
})
export type RuntimeSettings = typeof RuntimeSettings.Type

export const Manifest = Schema.Struct({
	owner: Schema.Literal('limitless-capsule-v1'),
	spec: CapsuleSpec,
	generation: Schema.Int.check(Schema.isGreaterThan(0)),
	phase: Schema.Literals([
		'preparing',
		'ready',
		'stopping',
		'stopped',
		'purging',
		'removing',
		'purged',
	]),
})
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
