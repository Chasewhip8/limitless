import { type FSWatcher, watch } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { Plugin } from '@opencode/plugin/effect'
import type { SessionContext } from '@opencode/plugin/effect/session'
import type { ShellCreateBefore } from '@opencode/plugin/effect/shell'
import type { Session } from '@opencode/schema/session'
import { Tool } from '@opencode/schema/tool'
import { DateTime, Effect, type JsonSchema, Schema, Semaphore } from 'effect'
import {
	type Registration,
	type RegistrationSnapshot,
	readRegistration,
	registrationPath,
	registrationStamp,
} from './registration'
import {
	executeTool,
	type PaseoTool,
	type SessionBinding,
	sessionBinding,
	type ToolResponse,
} from './tool-bridge'

const toolPrefix = 'paseo_'

/**
 * Commands and background processes must stay owned by OpenCode's shell,
 * not a second terminal lifecycle in Paseo.
 */
const excludedTools: ReadonlySet<string> = new Set([
	'list_terminals',
	'create_terminal',
	'kill_terminal',
	'capture_terminal',
	'send_terminal_keys',
])

class PaseoGuidanceError extends Schema.TaggedError<PaseoGuidanceError>()('PaseoGuidanceError', {
	message: Schema.String,
}) {}

const loadGuidance = Effect.tryPromise({
	try: async () =>
		(await readFile(new URL('./prompts/guidance.md', import.meta.url), 'utf8')).trim(),
	catch: () => new PaseoGuidanceError({ message: 'Unable to read the packaged Paseo guidance' }),
})

/** Lookup failure is Unavailable, not evidence that a binding has closed. */
type Resolution = SessionBinding | { readonly _tag: 'Unavailable' }

/**
 * Shared-service TUI/T3 sessions must not inherit Paseo tools; only a bound
 * session or its native children may use them.
 */
const resolveBinding = (
	session: Plugin.Context['session'],
	registration: Registration,
	sessionID: Session.ID,
) =>
	Effect.gen(function* () {
		const visited = new Set<string>()
		let current: Session.ID | undefined = sessionID
		while (current !== undefined && !visited.has(current)) {
			visited.add(current)
			const binding = yield* sessionBinding(registration, current)
			if (binding._tag === 'Bound') return binding as Resolution
			const info: Session.Info = yield* session.get({ sessionID: current })
			current = info.parentID
		}
		return { _tag: 'Unbound' } as Resolution
	}).pipe(Effect.catch(() => Effect.succeed<Resolution>({ _tag: 'Unavailable' })))

/** Match Paseo's OpenCode plugin's image convention. */
function toContent(part: ToolResponse['content'][number]): Tool.Content {
	if (part.type === 'text' && 'text' in part && typeof part.text === 'string')
		return { type: 'text', text: part.text }
	if (
		part.type === 'image' &&
		'data' in part &&
		typeof part.data === 'string' &&
		'mimeType' in part &&
		typeof part.mimeType === 'string'
	)
		return { type: 'file', uri: `data:${part.mimeType};base64,${part.data}`, mime: part.mimeType }
	return { type: 'text', text: JSON.stringify(part) }
}

/**
 * Paseo replaces a session's whole shell environment with a snapshot of the
 * Paseo daemon's. Shells keep the managed service's environment instead, plus
 * Paseo's own `PASEO_*` variables such as the agent's ID.
 */
export function restoreServiceEnvironment(
	input: Pick<ShellCreateBefore, 'env'>,
	service: NodeJS.ProcessEnv = process.env,
): void {
	if (input.env.PASEO_AGENT_ID === undefined) return
	const paseo = Object.entries(input.env).filter(([name]) => name.startsWith('PASEO_'))
	input.env = {
		...service,
		...Object.fromEntries(paseo),
		TERM: input.env.TERM,
		OPENCODE_TERMINAL: input.env.OPENCODE_TERMINAL,
	}
}

interface BoundExecution {
	readonly token: string
	readonly lastIdle: number | undefined
}

/**
 * Sessions can move between per-Location plugin instances mid-run, so ownership
 * is process-wide. The daemon token and last idle time identify an execution;
 * volatile OpenCode events cannot distinguish one execution from the next.
 */
export const boundExecutionsKey: unique symbol = Symbol.for('limitless.paseo.bound-executions.v2')
const processState: typeof globalThis & {
	[boundExecutionsKey]?: Map<string, BoundExecution>
} = globalThis
const boundExecutions = processState[boundExecutionsKey] ?? new Map<string, BoundExecution>()
processState[boundExecutionsKey] = boundExecutions

const lastIdle = (session: Plugin.Context['session'], sessionID: Session.ID) =>
	session
		.get({ sessionID })
		.pipe(
			Effect.map((info: Session.Info) =>
				info.time.idle === undefined ? undefined : DateTime.toEpochMillis(info.time.idle),
			),
		)

export default Plugin.define({
	id: 'paseo',
	effect: Effect.fn('paseo.plugin')(function* (ctx) {
		const guidance = yield* loadGuidance.pipe(Effect.orDie)
		yield* ctx.shell.hook('create.before', (input) =>
			Effect.sync(() => restoreServiceEnvironment(input)),
		)

		const path = yield* registrationPath().pipe(
			Effect.tapError(({ message }) => Effect.logError(`[paseo] ${message}`)),
			Effect.option,
		)
		if (path._tag === 'None') return
		let current: RegistrationSnapshot = { stamp: undefined, registration: undefined }
		const load = readRegistration(path.value).pipe(
			Effect.tapError(({ message }) => Effect.logWarning(`[paseo] ${message}`)),
			Effect.catch(() =>
				registrationStamp(path.value).pipe(
					Effect.map((stamp): RegistrationSnapshot => ({ stamp, registration: undefined })),
				),
			),
			Effect.tap((snapshot) =>
				Effect.sync(() => {
					current = snapshot
				}),
			),
		)
		yield* load

		const paseoTool = (tool: PaseoTool): Tool.Info => ({
			name: `${toolPrefix}${tool.name}`,
			description: tool.description,
			input: tool.inputSchema as JsonSchema.JsonSchema,
			// Direct tools pass through the context hook, which scopes them per session.
			options: { codemode: false },
			execute: (input, context) =>
				Effect.gen(function* () {
					const registration = current.registration
					if (registration === undefined)
						return yield* new Tool.Error({ message: 'Paseo is not connected to OpenCode' })
					const binding = yield* resolveBinding(ctx.session, registration, context.sessionID)
					if (binding._tag !== 'Bound' || !binding.tools.has(tool.name))
						return yield* new Tool.Error({
							message: `This session's Paseo agent cannot use ${tool.name}`,
						})
					const response = yield* executeTool(
						registration,
						binding.sessionID,
						tool.name,
						input,
					).pipe(Effect.mapError(({ message }) => new Tool.Error({ message })))
					const content = response.content.map(toContent)
					const metadata = { paseoTool: tool.name }
					if (response.isError === true)
						return yield* new Tool.Error({
							message:
								content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n') ||
								`Paseo tool ${tool.name} failed`,
							metadata,
						})
					return { content, metadata }
				}),
		})
		yield* ctx.tool.transform((editor) => {
			for (const tool of current.registration?.tools ?? [])
				if (!excludedTools.has(tool.name)) editor.add(paseoTool(tool))
		})

		// Watchers cover active and moved sessions; the prompt check covers a new agent's first step.
		const refreshing = Semaphore.makeUnsafe(1)
		const refresh = refreshing.withPermit(
			Effect.gen(function* () {
				const stamp = yield* registrationStamp(path.value)
				if (stamp === current.stamp) return
				yield* load
				yield* ctx.tool.reload()
			}),
		)
		const runFork = Effect.runForkWith(yield* Effect.context())
		yield* Effect.acquireRelease(
			Effect.promise(async (): Promise<FSWatcher | undefined> => {
				const directory = dirname(path.value)
				await mkdir(directory, { recursive: true, mode: 0o700 })
				try {
					return watch(directory, { persistent: false }, (_event, name) => {
						if (name === null || name === basename(path.value)) runFork(refresh)
					})
				} catch {
					return undefined
				}
			}),
			(watcher) => Effect.sync(() => watcher?.close()),
		)
		// The registration may have changed before the watcher started.
		yield* refresh
		yield* ctx.session.hook('prompt', () => refresh)

		/**
		 * Paseo normally stops an agent by closing its binding and exiting its server.
		 * The shared server outlives it, so binding closure must interrupt that execution instead.
		 */
		const scope = (input: SessionContext, agentStep: boolean) =>
			Effect.gen(function* () {
				const offered = Object.keys(input.tools).filter((name) => name.startsWith(toolPrefix))
				if (offered.length === 0) return
				const registration = current.registration
				const resolution =
					registration === undefined
						? ({ _tag: 'Unavailable' } as Resolution)
						: yield* resolveBinding(ctx.session, registration, input.sessionID)
				if (resolution._tag === 'Bound') {
					for (const name of offered)
						if (!resolution.tools.has(name.slice(toolPrefix.length))) delete input.tools[name]
					if (agentStep && registration !== undefined) {
						const idle = yield* lastIdle(ctx.session, input.sessionID).pipe(Effect.option)
						if (idle._tag === 'Some')
							boundExecutions.set(input.sessionID, {
								token: registration.token,
								lastIdle: idle.value,
							})
					}
					if (agentStep) input.system.push({ type: 'text', text: guidance })
					return
				}
				for (const name of offered) delete input.tools[name]
				const record = boundExecutions.get(input.sessionID)
				if (
					!agentStep ||
					resolution._tag !== 'Unbound' ||
					registration === undefined ||
					record?.token !== registration.token
				)
					return
				boundExecutions.delete(input.sessionID)
				const idle = yield* lastIdle(ctx.session, input.sessionID).pipe(Effect.option)
				if (idle._tag === 'Some' && idle.value === record.lastIdle) {
					yield* Effect.logInfo(`[paseo] interrupting ${input.sessionID}: Paseo closed its agent`)
					// Interrupting waits for the execution this hook is part of, so it runs detached.
					yield* ctx.session
						.interrupt({ sessionID: input.sessionID })
						.pipe(Effect.ignore, Effect.forkDetach)
				}
			})
		yield* ctx.session.hook('context', (input) => scope(input, true))
		yield* ctx.session.hook('generate', (input) => scope(input, false))
		yield* ctx.session.hook('compaction', (input) => scope(input, false))
	}),
})
