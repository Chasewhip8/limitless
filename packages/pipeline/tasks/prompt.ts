import type { PullRequest } from './schema'

export function reviewPrompt(taskId: string, pr: PullRequest): string {
	return [
		`Review ${pr.url} using your review agent instructions.`,
		`Pipeline task: ${taskId}. Initial PR head: ${pr.headSha}. Initial base: ${pr.baseSha}.`,
		'This authenticated submission authorizes the task-scoped actions defined by your review agent. It does not expand that agent’s authority.',
		'Work in this task’s retained checkout and session. Preserve local and unpublished work; do not reset or discard the checkout.',
	].join('\n\n')
}
export function continuePrompt(pr: string): string {
	return [
		`Continue the review of ${pr} using your review agent instructions in the same retained checkout and session.`,
		'Recheck the current PR head, findings, and any pushed fixes. Run the checks needed to finish or update your review report.',
		'Preserve local and unpublished work. If an earlier attempt was blocked or failed, continue from the retained evidence after checking whether that blocker is resolved.',
		'The original review authorization still applies; this continuation does not authorize production fixes or merging.',
	].join('\n\n')
}
