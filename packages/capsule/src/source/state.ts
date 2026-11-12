import { Effect, Schema } from 'effect'
import { type ArchiveMetadata, Resolved, SourceError, SourceRequest, SourceStatus } from './schema'

export const Manifest = Schema.Struct({
	owner: Schema.Literal('limitless-source-v1'),
	request: SourceRequest,
	resolved: Schema.optionalKey(Resolved),
	status: SourceStatus,
})
export type Manifest = typeof Manifest.Type

type Transition =
	| { readonly _tag: 'Prepare' }
	| { readonly _tag: 'Cloned' }
	| { readonly _tag: 'Configured' }
	| { readonly _tag: 'Published' }
	| { readonly _tag: 'Archive' }
	| { readonly _tag: 'Archived'; readonly archive: ArchiveMetadata }
	| { readonly _tag: 'Release' }
	| { readonly _tag: 'Released' }

export const transition = Effect.fn('Source.transition')(function* (
	status: SourceStatus,
	event: Transition,
) {
	const identity = { id: status.id, directory: status.directory }
	switch (status._tag) {
		case 'Absent':
			if (event._tag === 'Prepare')
				return { ...identity, _tag: 'Preparing', step: 'clone' } as const
			if (event._tag === 'Archive') return { ...identity, _tag: 'Archiving' } as const
			break
		case 'Preparing':
			if (event._tag === 'Archive') return { ...identity, _tag: 'Archiving' } as const
			switch (status.step) {
				case 'clone':
					if (event._tag === 'Cloned')
						return { ...identity, _tag: 'Preparing', step: 'configure' } as const
					break
				case 'configure':
					if (event._tag === 'Configured')
						return { ...identity, _tag: 'Preparing', step: 'publish' } as const
					break
				case 'publish':
					if (event._tag === 'Published') return { ...identity, _tag: 'Ready' } as const
					break
			}
			break
		case 'Ready':
			if (event._tag === 'Archive') return { ...identity, _tag: 'Archiving' } as const
			break
		case 'Archiving':
			if (event._tag === 'Archived')
				return { ...identity, _tag: 'Archived', archive: event.archive } as const
			break
		case 'Archived':
			if (event._tag === 'Release')
				return { ...identity, _tag: 'Releasing', archive: status.archive } as const
			break
		case 'Releasing':
			if (event._tag === 'Released')
				return { ...identity, _tag: 'Released', archive: status.archive } as const
			break
		case 'Released':
			break
		default: {
			const exhaustive: never = status
			return exhaustive
		}
	}
	return yield* SourceError.make({
		code: 'illegal_transition',
		message: 'The source phase does not permit this operation.',
	})
})
