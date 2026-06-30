import path from 'node:path'
import { Effect } from 'effect'
import { toolInputError } from '../errors'
import { ensureDirectory, writeBinaryFile, writeJsonFile, writeNewFile } from '../files'
import type { TypstTemplatesListInput, TypstTemplatesListResult } from '../schemas'
import { briefTemplate } from './brief'
import { sphereInstitutionalTemplate } from './sphere-institutional'
import { sphereInstitutionalPrintTemplate } from './sphere-institutional-print'
import { sphereInstitutionalShowcaseTemplate } from './sphere-institutional-showcase'
import type { TemplateArtifactEntry } from './types'

const DEFAULT_TEMPLATE = 'brief'

export const TYPST_TEMPLATE_DEFINITIONS = [
	briefTemplate,
	sphereInstitutionalTemplate,
	sphereInstitutionalPrintTemplate,
	sphereInstitutionalShowcaseTemplate,
] as const
export type TypstTemplateDefinition = (typeof TYPST_TEMPLATE_DEFINITIONS)[number]

export const resolveTemplate = Effect.fn(function* resolveTemplate(
	template: string | undefined,
	toolName: string,
) {
	const name = template ?? DEFAULT_TEMPLATE
	const definition = TYPST_TEMPLATE_DEFINITIONS.find(
		(candidate) => candidate.metadata.name === name,
	)
	if (definition !== undefined) return definition
	return yield* Effect.fail(toolInputError(toolName, `unknown Typst template: ${name}`))
})

function templateTargetPath(root: string, entry: TemplateArtifactEntry): string {
	return path.join(root, entry.path)
}

export const instantiateTemplate = Effect.fn(function* instantiateTemplate(
	definition: TypstTemplateDefinition,
	input: {
		readonly directory: string
		readonly title?: string | undefined
		readonly toolName: string
	},
) {
	for (const entry of definition.files({ title: input.title })) {
		const target = templateTargetPath(input.directory, entry)
		switch (entry.kind) {
			case 'directory':
				yield* ensureDirectory(target, true, input.toolName, 'Could not create template directory')
				break
			case 'text':
				yield* writeNewFile(target, entry.content, input.toolName)
				break
			case 'json':
				yield* writeJsonFile(target, entry.value, input.toolName)
				break
			case 'binary':
				yield* writeBinaryFile(target, entry.content, input.toolName)
				break
			default: {
				const exhaustive: never = entry
				return exhaustive
			}
		}
	}
})

export const typstTemplatesList = Effect.fn(function* typstTemplatesList(
	_input: TypstTemplatesListInput,
) {
	yield* Effect.void
	return {
		ok: true,
		templates: TYPST_TEMPLATE_DEFINITIONS.map((definition) => definition.metadata),
	} satisfies TypstTemplatesListResult
})
