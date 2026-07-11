import { createHash } from 'node:crypto'
import { Effect, Schema } from 'effect'
import { cloneFailure } from './errors'
import { GitHubRef, GitHubRepository } from './schema'

export function trimmed(value: string | undefined): string | undefined {
	if (value === undefined) return undefined
	const result = value.trim()
	return result.length === 0 ? undefined : result
}

export function cleanRemoteUrl(repo: string): string {
	return `https://github.com/${repo}.git`
}

export const normalizeRepo = Effect.fn('normalizeRepo')(function* (repo: string) {
	const decoded = yield* Schema.decodeUnknownEffect(GitHubRepository)(repo).pipe(
		Effect.mapError(() =>
			cloneFailure('REPOSITORY_NOT_ALLOWED', `Invalid GitHub repository name: ${repo}`),
		),
	)
	return decoded.trim().toLowerCase()
})

export const validateGitHubRef = Effect.fn('validateGitHubRef')(function* (
	ref: string | undefined,
) {
	if (ref === undefined) return undefined
	const value = ref.trim()
	return yield* Schema.decodeUnknownEffect(GitHubRef)(value).pipe(
		Effect.mapError(() => cloneFailure('INVALID_REF', `Invalid Git ref: ${value}`)),
	)
})

export const assertAllowedRepo = Effect.fn('assertAllowedRepo')(function* (
	repo: string,
	allowedRepos: ReadonlyArray<string>,
) {
	const normalized = yield* normalizeRepo(repo)
	if (allowedRepos.length === 0) return normalized
	const allowed = new Set(yield* Effect.forEach(allowedRepos, normalizeRepo))
	if (!allowed.has(normalized)) {
		return yield* cloneFailure(
			'REPOSITORY_NOT_ALLOWED',
			`Repository ${normalized} is not in the configured GitHub allowlist.`,
		)
	}
	return normalized
})

export function cloneDirectoryNameFromValidated(
	normalizedRepo: GitHubRepository,
	validatedRef: GitHubRef | undefined,
): string {
	const base = `github-${normalizedRepo.replace('/', '-')}`
	if (validatedRef === undefined) return base
	const readable =
		validatedRef
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, '-')
			.replace(/^-+|-+$/gu, '')
			.slice(0, 40) || 'ref'
	const hash = createHash('sha256').update(validatedRef).digest('hex').slice(0, 12)
	return `${base}-${readable}-${hash}`
}

export const cloneDirectoryName = Effect.fn('cloneDirectoryName')(function* (
	repo: string,
	ref?: string,
) {
	const normalized = yield* normalizeRepo(repo)
	const validRef = yield* validateGitHubRef(ref)
	if (ref !== undefined && validRef === undefined)
		return yield* cloneFailure('INVALID_REF', 'GitHub ref cannot be empty.')
	return cloneDirectoryNameFromValidated(normalized, validRef)
})
