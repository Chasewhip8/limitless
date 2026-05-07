import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { workspacePath, workspaceRoot } from '../packages/limitless/shared'

type WorkspaceRootContext = Parameters<typeof workspaceRoot>[1]

const context: WorkspaceRootContext = {
	sessionID: 'session',
	messageID: 'message',
	agent: 'limitless',
	directory: '/ignored/directory',
	worktree: '/repo',
	abort: new AbortController().signal,
	metadata: () => undefined,
	ask: () => {
		throw new Error('ask is not used by workspaceRoot.')
	},
}

describe('workspaceRoot', () => {
	test('uses context.worktree by default', () => {
		expect(workspaceRoot({}, context)).toBe(path.resolve('/repo'))
	})

	test('accepts external input.workspace', () => {
		expect(workspaceRoot({ workspace: '/other/repo' }, context)).toBe(path.resolve('/other/repo'))
	})

	test('resolves relative input.workspace against context.worktree', () => {
		expect(workspaceRoot({ workspace: 'packages/app' }, context)).toBe(
			path.resolve('/repo/packages/app'),
		)
	})
})

describe('workspacePath', () => {
	test('resolves relative paths against workspace', () => {
		expect(workspacePath('/repo', 'src/a.ts')).toBe(path.resolve('/repo/src/a.ts'))
	})

	test('accepts ../ paths', () => {
		expect(workspacePath('/repo', '../other/a.ts')).toBe(path.resolve('/other/a.ts'))
	})

	test('accepts absolute paths outside workspace', () => {
		expect(workspacePath('/repo', '/tmp/a.ts')).toBe(path.resolve('/tmp/a.ts'))
	})

	test('normalizes paths predictably', () => {
		expect(workspacePath('/repo/./app', 'src/../a.ts')).toBe(path.resolve('/repo/app/a.ts'))
		expect(workspacePath('/repo', '/tmp/../a.ts')).toBe(path.resolve('/a.ts'))
	})
})
