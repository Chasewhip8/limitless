import type { PullRequest } from './schema'

export function reviewPrompt(taskId: string, pr: PullRequest): string {
	return [
		`Review ${pr.url} using your review agent instructions.`,
		`Pipeline task: ${taskId}. Initial PR head: ${pr.headSha}. Initial base: ${pr.baseSha}.`,
		'This authenticated submission authorizes the task-scoped actions defined by your review agent. It does not expand that agent’s authority.',
		'Work in this task’s retained checkout and session. Preserve local and unpublished work; do not reset or discard the checkout.',
	].join('\n\n')
}
export function resumePrompt(pr: string, message: string): string {
	return `Continue the review of ${pr} in the same retained checkout and session. Preserve local and unpublished work.\n\n${message}`
}
