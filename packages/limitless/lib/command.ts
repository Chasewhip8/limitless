export type CommandResult = {
	readonly ok: boolean
	readonly exitCode: number | null
	readonly signal?: string | null
	readonly stdout: string
	readonly stderr: string
}

export type RunOptions = {
	readonly cwd?: string
	readonly timeout?: number
	readonly maxBuffer?: number
	readonly env?: Readonly<Record<string, string | undefined>>
	readonly signal?: AbortSignal
}
