import { Effect, Schema } from 'effect'
import type { CommandResult } from '../../core/command'
import { runCommand } from '../../core/command'
import { cloneFailure } from './errors'
import { trimmed } from './repository'
import type { GitRuntime } from './runtime'
import { GitCommitSha } from './schema'

function sanitize(value: string, secrets: ReadonlyArray<string>): string {
	let result = value
	for (const secret of secrets)
		if (secret.length > 0) result = result.replaceAll(secret, '[REDACTED]')
	return result.replace(/https:\/\/[^\s/@]+@github\.com/giu, 'https://[REDACTED]@github.com')
}

export const runGit = Effect.fn('runGit')(function* (
	runtime: GitRuntime,
	args: ReadonlyArray<string>,
	cwd: string,
) {
	const result = yield* runCommand(runtime.gitBin, args, {
		cwd,
		timeout: runtime.timeoutMs,
		env: runtime.env,
		signal: runtime.signal,
	})
	return {
		...result,
		stdout: sanitize(result.stdout, runtime.secrets),
		stderr: sanitize(result.stderr, runtime.secrets),
	} satisfies CommandResult
})

export const git = Effect.fn('git')(function* (
	runtime: GitRuntime,
	cwd: string,
	action: string,
	args: ReadonlyArray<string>,
) {
	const result = yield* runGit(runtime, args, cwd)
	if (!result.ok) {
		if (runtime.signal.aborted) return yield* cloneFailure('ABORTED', `Git ${action} was aborted.`)
		const detail = trimmed(result.stderr) ?? trimmed(result.stdout) ?? 'Git exited without output.'
		return yield* cloneFailure('GIT_COMMAND_FAILED', `Git ${action} failed: ${detail}`)
	}
	return result.stdout.trim()
})

const parseDefaultHead = Effect.fn('parseDefaultHead')(function* (output: string) {
	for (const line of output.split(/\r?\n/gu)) {
		const symbolic = /^ref:\s+(refs\/heads\/[^\s]+)\s+HEAD$/u.exec(line)
		if (symbolic?.[1] !== undefined) return symbolic[1]
	}
	for (const line of output.split(/\r?\n/gu)) {
		const direct = /^([0-9a-fA-F]{40,64})\s+HEAD$/u.exec(line)
		if (direct?.[1] !== undefined) return direct[1]
	}
	return yield* cloneFailure(
		'REF_RESOLUTION_FAILED',
		'GitHub repository did not advertise a default HEAD.',
	)
})

export const decodeCommit = Effect.fn('decodeCommit')(function* (commit: string) {
	return yield* Schema.decodeUnknownEffect(GitCommitSha)(commit).pipe(
		Effect.mapError(() =>
			cloneFailure('REF_RESOLUTION_FAILED', 'Git returned an invalid resolved commit SHA.'),
		),
	)
})

export const fetchSnapshot = Effect.fn('fetchSnapshot')(function* (
	runtime: GitRuntime,
	target: string,
	requestedRef: string | undefined,
) {
	const ref =
		requestedRef ??
		(yield* git(runtime, target, 'default branch resolution', [
			'ls-remote',
			'--symref',
			'origin',
			'HEAD',
		]).pipe(Effect.flatMap(parseDefaultHead)))
	yield* git(runtime, target, 'snapshot fetch', ['fetch', '--depth=1', '--no-tags', 'origin', ref])
	const commit = yield* git(runtime, target, 'fetched commit resolution', [
		'rev-parse',
		'FETCH_HEAD^{commit}',
	])
	return yield* decodeCommit(commit)
})

export const checkoutSnapshot = Effect.fn('checkoutSnapshot')(function* (
	runtime: GitRuntime,
	target: string,
	commit: GitCommitSha,
) {
	yield* git(runtime, target, 'snapshot checkout', ['checkout', '--detach', '--force', commit])
})
