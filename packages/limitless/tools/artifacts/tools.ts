import {
	defineLimitlessTool,
	encodeToolFailure,
	type ToolExecutor,
} from '../../plugin/tool-boundary'
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

export function artifactTools(executeTool: ToolExecutor) {
	return {
		artifact_create: defineLimitlessTool({
			name: 'artifact_create',
			description:
				'Create an empty durable project-scoped artifact workspace or instantiate one from a built-in artifact template.',
			input: ArtifactCreateInput,
			output: ArtifactCreateResult,
			execute: (args, context) =>
				executeTool('artifact_create', args, context, artifactCreate, encodeToolFailure),
		}),
		artifact_list: defineLimitlessTool({
			name: 'artifact_list',
			description:
				'List durable project-scoped artifact workspaces, optionally filtered by template.',
			input: ArtifactListInput,
			output: ArtifactListResult,
			execute: (args, context) =>
				executeTool('artifact_list', args, context, artifactList, encodeToolFailure),
		}),
		artifact_templates_list: defineLimitlessTool({
			name: 'artifact_templates_list',
			description: 'List built-in artifact templates available to artifact_create.',
			input: ArtifactTemplatesListInput,
			output: ArtifactTemplatesListResult,
			execute: (args, context) =>
				executeTool(
					'artifact_templates_list',
					args,
					context,
					artifactTemplatesList,
					encodeToolFailure,
				),
		}),
		artifact_template_read: defineLimitlessTool({
			name: 'artifact_template_read',
			description:
				'Read a text file from a built-in artifact template without creating an artifact (for example the sphere-showcase authoring reference).',
			input: ArtifactTemplateReadInput,
			output: ArtifactTemplateReadResult,
			execute: (args, context) =>
				executeTool(
					'artifact_template_read',
					args,
					context,
					artifactTemplateRead,
					encodeToolFailure,
				),
		}),
		typst_compile: defineLimitlessTool({
			name: 'typst_compile',
			description: 'Compile a Typst document artifact to PDF using the packaged Typst binary.',
			input: TypstCompileInput,
			output: TypstCompileResult,
			execute: (args, context) =>
				executeTool('typst_compile', args, context, typstCompile, encodeToolFailure),
		}),
	}
}
