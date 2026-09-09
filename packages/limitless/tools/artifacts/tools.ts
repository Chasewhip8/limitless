import {
	defineLimitlessTool,
	encodeToolFailure,
	type ToolExecutor,
} from '../../plugin/tool-boundary'
import { ArtifactCreateInput, ArtifactCreateResult, artifactCreate } from './create'
import { ArtifactListInput, ArtifactListResult, artifactList } from './list'

export function artifactTools(executeTool: ToolExecutor) {
	return {
		artifact_create: defineLimitlessTool({
			name: 'artifact_create',
			description:
				'Create a durable project-scoped artifact folder with a manifest. Add Markdown notes and scratchpads using the normal file tools.',
			input: ArtifactCreateInput,
			output: ArtifactCreateResult,
			execute: (args, context) =>
				executeTool('artifact_create', args, context, artifactCreate, encodeToolFailure),
		}),
		artifact_list: defineLimitlessTool({
			name: 'artifact_list',
			description:
				'List durable project-scoped artifact folders with valid manifests and report folders with missing or invalid manifests.',
			input: ArtifactListInput,
			output: ArtifactListResult,
			execute: (args, context) =>
				executeTool('artifact_list', args, context, artifactList, encodeToolFailure),
		}),
	}
}
