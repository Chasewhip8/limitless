import path from 'node:path'

export function pathIsInside(parent: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(candidate))
	return (
		relative === '' ||
		(!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
	)
}
