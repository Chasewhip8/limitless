import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { ToolContext } from '@opencode-ai/plugin'
import { Effect } from 'effect'
import { artifactOperationError, decodeToolValue, isAlreadyExists, toolInputError } from './errors'
import { ensureArtifactsRoot, writeJsonFile, writeNewFile } from './files'
import { artifactManifestRelativePath, artifactRelativePath, generatedArtifactSlug } from './paths'
import {
	type ArtifactCreateInput,
	type ArtifactCreateResult,
	ArtifactKind,
	type ArtifactKind as ArtifactKindType,
	type ArtifactManifest,
	type ArtifactSlug,
} from './schemas'
import {
	instantiateTemplate,
	resolveTemplate,
	type TypstTemplateDefinition,
} from './templates/index'

const MAX_TITLE_LENGTH = 160

const normalizeTitle = Effect.fn(function* normalizeTitle(title: string | undefined) {
	if (title === undefined) return undefined
	const trimmed = title.trim()
	if (trimmed.length === 0) return undefined
	if (trimmed.length > MAX_TITLE_LENGTH) {
		return yield* Effect.fail(
			toolInputError('artifact_create', `title must be ${MAX_TITLE_LENGTH} characters or fewer`),
		)
	}
	return trimmed
})

const normalizeKind = Effect.fn(function* normalizeKind(kind: string | undefined) {
	return yield* decodeToolValue(
		'artifact_create',
		ArtifactKind,
		kind ?? 'scratchpad',
		'kind must be scratchpad, document, or generic',
	)
})

const createArtifactDirectory = Effect.fn(function* createArtifactDirectory(
	root: string,
	slug: ArtifactSlug,
	generated: boolean,
) {
	return yield* Effect.tryPromise({
		try: async () => {
			try {
				await mkdir(path.join(root, slug))
				return true
			} catch (error) {
				if (isAlreadyExists(error) && generated) return false
				throw error
			}
		},
		catch: (error) =>
			artifactOperationError('artifact_create', 'Could not create artifact workspace', error),
	})
})

function createManifest(
	input: {
		readonly kind: ArtifactKindType
		readonly slug: ArtifactSlug
		readonly title?: string | undefined
		readonly template?: string | undefined
	},
	context: ToolContext,
): ArtifactManifest {
	return {
		slug: input.slug,
		kind: input.kind,
		createdAt: new Date().toISOString(),
		...(input.title !== undefined ? { title: input.title } : {}),
		...(input.template !== undefined ? { template: input.template } : {}),
		createdBy: {
			sessionID: context.sessionID,
			agent: context.agent,
		},
	}
}

const initializeArtifactFiles = Effect.fn(function* initializeArtifactFiles(
	directory: string,
	manifest: ArtifactManifest,
	template: TypstTemplateDefinition | undefined,
) {
	yield* writeJsonFile(path.join(directory, 'manifest.json'), manifest, 'artifact_create')

	switch (manifest.kind) {
		case 'scratchpad':
			yield* writeNewFile(path.join(directory, 'scratch.md'), '', 'artifact_create')
			return
		case 'document':
			if (template === undefined) {
				return yield* Effect.fail(
					toolInputError('artifact_create', 'document artifacts require a template'),
				)
			}
			yield* instantiateTemplate(template, {
				directory,
				title: manifest.title,
				toolName: 'artifact_create',
			})
			return
		case 'generic':
			return
		default: {
			const exhaustive: never = manifest.kind
			return exhaustive
		}
	}
})

export const artifactCreate = Effect.fn(function* artifactCreate(
	input: ArtifactCreateInput,
	context: ToolContext,
) {
	const kind = yield* normalizeKind(input.kind)
	const title = yield* normalizeTitle(input.title)
	if (input.template !== undefined && kind !== 'document') {
		return yield* Effect.fail(
			toolInputError('artifact_create', 'template is only valid for document artifacts'),
		)
	}
	const template =
		kind === 'document' ? yield* resolveTemplate(input.template, 'artifact_create') : undefined

	const root = yield* ensureArtifactsRoot(context.worktree, true, 'artifact_create')
	if (root === undefined) {
		return yield* Effect.fail(toolInputError('artifact_create', 'Could not create artifacts root'))
	}

	const generated = input.slug === undefined
	let slug = input.slug ?? generatedArtifactSlug(kind, title)
	let created = yield* createArtifactDirectory(root, slug, generated)
	for (let attempt = 0; !created && attempt < 5; attempt += 1) {
		slug = generatedArtifactSlug(kind, title)
		created = yield* createArtifactDirectory(root, slug, true)
	}
	if (!created) {
		return yield* Effect.fail(
			toolInputError('artifact_create', 'Could not allocate a unique artifact slug'),
		)
	}

	const directory = path.join(root, slug)
	const manifest = createManifest({ kind, slug, title, template: template?.metadata.name }, context)
	yield* initializeArtifactFiles(directory, manifest, template)

	return {
		ok: true,
		slug,
		path: artifactRelativePath(slug),
		manifestPath: artifactManifestRelativePath(slug),
		created: true,
		manifest,
	} satisfies ArtifactCreateResult
})
