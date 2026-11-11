import { createHash } from 'node:crypto'
import type { InterruptRequest, ResumeRequest, ReviewRequest } from './schema'

const hash = (fields: ReadonlyArray<string | null>) =>
	createHash('sha256').update(JSON.stringify(fields)).digest('hex')

export const reviewIntent = (request: ReviewRequest) =>
	hash(['review', request.pr.replace(/\/$/, '').toLowerCase(), request.system ?? null])

export const resumeIntent = (taskId: string, request: ResumeRequest) =>
	hash(['resume', taskId, request.afterCommandId, request.message])

export const interruptIntent = (taskId: string, request: InterruptRequest) =>
	hash(['interrupt', taskId, request.afterCommandId])
