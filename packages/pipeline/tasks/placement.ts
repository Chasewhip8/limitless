import path from 'node:path'
import type { HostInfo } from '@limitless/capsule/rpc'
import type { SessionIdentity, Worker } from '../worker/schema'
import { Assignment, type Task } from './schema'

export const pipelineWorkspaceId = (taskId: string) => `wrk_pipeline${taskId.replaceAll('-', '')}`
export const pipelineSessionId = (taskId: string) => `ses_pipeline${taskId.replaceAll('-', '')}`

export function newAssignment(worker: Worker, host: HostInfo, taskId: string): Assignment {
	const workspaceId = pipelineWorkspaceId(taskId)
	return Assignment.make({
		workerId: worker.id,
		workerUrl: worker.url,
		controlDirectory: worker.controlDirectory,
		storageId: host.storageId,
		workspaceId,
		sessionId: pipelineSessionId(taskId),
		directory: path.join(host.checkoutRoot, workspaceId, 'checkout'),
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
			worker.controlDirectory === assignment.controlDirectory,
	)
}

export function sessionIdentity(task: Task, assignment: Assignment): SessionIdentity {
	return {
		taskId: task.id,
		storageId: assignment.storageId,
		workspaceId: assignment.workspaceId,
		sessionId: assignment.sessionId,
		directory: assignment.directory,
	}
}
