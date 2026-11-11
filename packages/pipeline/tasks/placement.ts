import path from 'node:path'
import type { SessionIdentity, Worker } from '../worker/schema'
import { Assignment, type Task } from './schema'

export function newAssignment(worker: Worker, taskId: string): Assignment {
	return Assignment.make({
		workerId: worker.id,
		workerUrl: worker.url,
		workspaceRoot: worker.workspaceRoot,
		helperExecutable: worker.helperExecutable,
		directory: path.join(worker.workspaceRoot, taskId, 'checkout'),
		sessionId: `ses_pipeline${taskId.replaceAll('-', '')}`,
	})
}

export function pinnedWorker(
	workers: ReadonlyArray<Worker>,
	assignment: Assignment,
): Worker | undefined {
	return workers.find(
		(worker) =>
			worker.id === assignment.workerId &&
			worker.url === assignment.workerUrl &&
			worker.workspaceRoot === assignment.workspaceRoot &&
			worker.helperExecutable === assignment.helperExecutable,
	)
}

export function sessionIdentity(task: Task, assignment: Assignment): SessionIdentity {
	return {
		taskId: task.id,
		sessionId: assignment.sessionId,
		directory: assignment.directory,
		pr: task.request.pr,
	}
}
