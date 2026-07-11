import { tool } from '@opencode-ai/plugin'
import { executeTool } from '../../core/tool-boundary'
import { githubClone } from './clone'
import { GitHubCloneInput, GitHubCloneResult } from './clone-schema'
import type { GitHubPluginConfig } from './config'
import type { GitHubCloneRuntime } from './runtime'

export function githubTools(github: GitHubPluginConfig, runtime: GitHubCloneRuntime) {
	if (!github.enabled) return {}
	return {
		github_clone: tool({
			description:
				'Create or refresh a read-only shallow GitHub checkout under .limitless/repos, including allowed transitive submodules. Git LFS objects are not materialized.',
			args: { repo: tool.schema.string(), ref: tool.schema.string().optional() },
			execute: (args, context) =>
				executeTool('github_clone', GitHubCloneInput, GitHubCloneResult, args, context, (input) =>
					githubClone(github.config, input, context, runtime),
				),
		}),
	}
}
