import { Schema } from 'effect'

export const CapsuleId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/))
export const Text = Schema.String.check(
	Schema.makeFilter((value) => !value.includes('\0') || 'Must not contain a NUL character'),
)
export const AbsolutePath = Text.check(Schema.isPattern(/^\//))
