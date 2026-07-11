import path from 'node:path'
import type { ToolContext } from '@opencode-ai/plugin'

export function workspaceRoot(
	input: { readonly workspace?: string | undefined },
	context: ToolContext,
): string {
	if (input.workspace === undefined) return path.resolve(context.worktree)
	return path.isAbsolute(input.workspace)
		? path.resolve(input.workspace)
		: path.resolve(context.worktree, input.workspace)
}

export function workspacePath(workspace: string, filePath: string): string {
	return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workspace, filePath)
}

export function workspaceRelative(workspace: string, filePath: string): string {
	const relative = path.relative(workspace, filePath)
	return relative.length === 0 ? '.' : relative
}

export function pathIsInside(parent: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(candidate))
	return (
		relative === '' ||
		(!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
	)
}

export function pathsOverlap(left: string, right: string): boolean {
	return pathIsInside(left, right) || pathIsInside(right, left)
}
