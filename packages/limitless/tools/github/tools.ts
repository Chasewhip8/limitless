import { defineLimitlessTool, encodeNoError, type ToolExecutor } from '../../plugin/tool-boundary'
import { githubClone } from './clone'
import { GitHubCloneInput, GitHubCloneResult } from './clone-schema'
import type { GitHubPluginConfig } from './config'
import type { GitHubCloneRuntime } from './runtime'

export function githubTools(
	executeTool: ToolExecutor,
	github: GitHubPluginConfig,
	runtime: GitHubCloneRuntime,
) {
	return {
		github_clone: defineLimitlessTool({
			name: 'github_clone',
			description:
				'Create or refresh a read-only shallow GitHub checkout under .limitless/repos, including allowed transitive submodules. Git LFS objects are not materialized.',
			input: GitHubCloneInput,
			output: GitHubCloneResult,
			execute: (args, context) =>
				executeTool(
					'github_clone',
					args,
					context,
					(input) => githubClone(github.config, input, runtime),
					encodeNoError,
				),
		}),
	}
}
