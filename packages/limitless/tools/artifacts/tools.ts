import { tool } from '@opencode-ai/plugin'
import { executeTool } from '../../core/tool-boundary'
import { ArtifactCreateInput, ArtifactCreateResult, artifactCreate } from './create'
import { ArtifactListInput, ArtifactListResult, artifactList } from './list'
import {
	ArtifactTemplateReadInput,
	ArtifactTemplateReadResult,
	ArtifactTemplatesListInput,
	ArtifactTemplatesListResult,
	artifactTemplateRead,
	artifactTemplatesList,
} from './templates'
import { TypstCompileInput, TypstCompileResult, typstCompile } from './typst'

export function artifactTools() {
	return {
		artifact_create: tool({
			description:
				'Create an empty durable project-scoped artifact workspace or instantiate one from a built-in artifact template.',
			args: {
				title: tool.schema.string().optional(),
				slug: tool.schema.string().optional(),
				template: tool.schema.string().optional(),
			},
			execute: (args, context) =>
				executeTool(
					'artifact_create',
					ArtifactCreateInput,
					ArtifactCreateResult,
					args,
					context,
					(input) => artifactCreate(input, context),
				),
		}),
		artifact_list: tool({
			description:
				'List durable project-scoped artifact workspaces, optionally filtered by template.',
			args: { template: tool.schema.string().optional() },
			execute: (args, context) =>
				executeTool(
					'artifact_list',
					ArtifactListInput,
					ArtifactListResult,
					args,
					context,
					(input) => artifactList(input, context),
				),
		}),
		artifact_templates_list: tool({
			description: 'List built-in artifact templates available to artifact_create.',
			args: {},
			execute: (args, context) =>
				executeTool(
					'artifact_templates_list',
					ArtifactTemplatesListInput,
					ArtifactTemplatesListResult,
					args,
					context,
					artifactTemplatesList,
				),
		}),
		artifact_template_read: tool({
			description:
				'Read a text file from a built-in artifact template without creating an artifact (for example the sphere-showcase authoring reference).',
			args: { template: tool.schema.string(), file: tool.schema.string() },
			execute: (args, context) =>
				executeTool(
					'artifact_template_read',
					ArtifactTemplateReadInput,
					ArtifactTemplateReadResult,
					args,
					context,
					artifactTemplateRead,
				),
		}),
		typst_compile: tool({
			description: 'Compile a Typst document artifact to PDF using the packaged Typst binary.',
			args: {
				artifact: tool.schema.string(),
				entry: tool.schema.string().optional(),
				format: tool.schema.string().optional(),
				timeoutMs: tool.schema.number().optional(),
			},
			execute: (args, context) =>
				executeTool(
					'typst_compile',
					TypstCompileInput,
					TypstCompileResult,
					args,
					context,
					(input) => typstCompile(input, context),
				),
		}),
	}
}
