import type { Dirent, Stats } from 'node:fs'
import { lstat, mkdir, open, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { ToolContext } from '@opencode-ai/plugin'
import { Effect, Schema } from 'effect'
import { objectProperty, ToolInputError } from './shared'

export const SCRATCHPAD_DIRECTORY = '.limitless'

const SCRATCHPAD_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u

export const ScratchpadCreateInput = Schema.Struct({
	name: Schema.String,
})

export type ScratchpadCreateInput = typeof ScratchpadCreateInput.Type

export const ScratchpadListInput = Schema.Struct({})

export type ScratchpadListInput = typeof ScratchpadListInput.Type

export type ScratchpadCreateResult = {
	readonly ok: true
	readonly name: string
	readonly path: string
	readonly created: boolean
}

export type ScratchpadListEntry = {
	readonly name: string
	readonly path: string
	readonly sizeBytes: number
	readonly updatedAt: string
}

export type ScratchpadListResult = {
	readonly ok: true
	readonly files: ReadonlyArray<ScratchpadListEntry>
}

export function validateScratchpadName(name: string): string | undefined {
	if (name.length === 0) return 'name is required'
	if (name === '.' || name === '..') return 'name must be a file name, not . or ..'
	if (!SCRATCHPAD_NAME_PATTERN.test(name)) {
		return 'name must be 1-128 characters and contain only letters, numbers, dot, underscore, or hyphen'
	}
	return undefined
}

function assertScratchpadName(name: string): string {
	const error = validateScratchpadName(name)
	if (error !== undefined) throw new Error(error)
	return name
}

export function scratchpadSessionSegment(sessionID: string): string {
	const encoded = encodeURIComponent(sessionID)
	if (encoded.length === 0) return 'session'
	if (encoded === '.' || encoded === '..')
		return `session-${Buffer.from(sessionID).toString('hex')}`
	return encoded
}

export function scratchpadRelativePath(sessionID: string, name: string): string {
	return path.posix.join(
		SCRATCHPAD_DIRECTORY,
		scratchpadSessionSegment(sessionID),
		assertScratchpadName(name),
	)
}

export function scratchpadRoot(worktree: string, sessionID: string): string {
	return path.resolve(worktree, SCRATCHPAD_DIRECTORY, scratchpadSessionSegment(sessionID))
}

export function scratchpadFilePath(worktree: string, sessionID: string, name: string): string {
	return path.resolve(worktree, scratchpadRelativePath(sessionID, name))
}

function toolInputError(toolName: string, message: string) {
	return new ToolInputError({ tool: toolName, message })
}

function scratchpadOperationError(toolName: string, message: string, error: unknown) {
	const code = objectProperty(error, 'code')
	const suffix = typeof code === 'string' ? ` (${code})` : ''
	return toolInputError(toolName, `${message}${suffix}`)
}

function isAlreadyExists(error: unknown): boolean {
	return objectProperty(error, 'code') === 'EEXIST'
}

function isMissingPath(error: unknown): boolean {
	const code = objectProperty(error, 'code')
	return code === 'ENOENT' || code === 'ENOTDIR'
}

async function ensureDirectory(directory: string, create: boolean): Promise<boolean> {
	let info: Stats
	try {
		info = await lstat(directory)
	} catch (error) {
		if (!isMissingPath(error)) throw new Error('Could not inspect scratchpad directory')
		if (!create) return false

		try {
			await mkdir(directory)
		} catch (mkdirError) {
			if (!isAlreadyExists(mkdirError)) throw new Error('Could not create scratchpad directory')
		}
		info = await lstat(directory)
	}

	if (!info.isDirectory()) throw new Error('Scratchpad directory is not a regular directory')
	return true
}

async function ensureScratchpadRoot(
	worktree: string,
	sessionID: string,
	create: boolean,
): Promise<string | undefined> {
	const base = path.resolve(worktree, SCRATCHPAD_DIRECTORY)
	if (!(await ensureDirectory(base, create))) return undefined

	const root = scratchpadRoot(worktree, sessionID)
	return (await ensureDirectory(root, create)) ? root : undefined
}

export function scratchpadCreate(
	input: ScratchpadCreateInput,
	context: ToolContext,
): Effect.Effect<ScratchpadCreateResult, ToolInputError> {
	const nameError = validateScratchpadName(input.name)
	if (nameError !== undefined) return Effect.fail(toolInputError('scratchpad_create', nameError))

	const filePath = scratchpadFilePath(context.worktree, context.sessionID, input.name)
	const relativePath = scratchpadRelativePath(context.sessionID, input.name)

	return Effect.tryPromise({
		try: async (): Promise<ScratchpadCreateResult> => {
			await ensureScratchpadRoot(context.worktree, context.sessionID, true)
			let created = true

			try {
				const handle = await open(filePath, 'wx')
				await handle.close()
			} catch (error) {
				if (!isAlreadyExists(error)) throw error
				created = false

				const existing = await lstat(filePath)
				if (!existing.isFile())
					throw new Error('scratchpad path already exists and is not a regular file')
			}

			return { ok: true, name: input.name, path: relativePath, created }
		},
		catch: (error) =>
			scratchpadOperationError(
				'scratchpad_create',
				`Could not create scratchpad file ${relativePath}`,
				error,
			),
	})
}

export function scratchpadList(
	_input: ScratchpadListInput,
	context: ToolContext,
): Effect.Effect<ScratchpadListResult, ToolInputError> {
	return Effect.tryPromise({
		try: async (): Promise<ScratchpadListResult> => {
			const root = await ensureScratchpadRoot(context.worktree, context.sessionID, false)
			if (root === undefined) return { ok: true, files: [] }

			let entries: Array<Dirent>
			try {
				entries = await readdir(root, { withFileTypes: true })
			} catch (error) {
				if (isMissingPath(error)) return { ok: true, files: [] }
				throw error
			}

			const files: Array<ScratchpadListEntry> = []
			for (const entry of entries) {
				if (!entry.isFile()) continue
				const nameError = validateScratchpadName(entry.name)
				if (nameError !== undefined) continue

				const filePath = scratchpadFilePath(context.worktree, context.sessionID, entry.name)
				const info = await lstat(filePath)
				files.push({
					name: entry.name,
					path: scratchpadRelativePath(context.sessionID, entry.name),
					sizeBytes: Number(info.size),
					updatedAt: info.mtime.toISOString(),
				})
			}

			files.sort((left, right) => left.name.localeCompare(right.name))
			return { ok: true, files }
		},
		catch: (error) =>
			scratchpadOperationError('scratchpad_list', 'Could not list scratchpad files', error),
	})
}
