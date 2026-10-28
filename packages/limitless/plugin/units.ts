import { join } from 'node:path'
import type { Plugin } from '@opencode/plugin/effect'
import { Agent } from '@opencode/schema/agent'
import { AbsolutePath } from '@opencode/schema/schema'
import { Session } from '@opencode/schema/session'
import { Tool } from '@opencode/schema/tool'
import { Effect, Option, Schema } from 'effect'

const metadataKey = 'limitless.unit'
const placementVersion = '2.1.4'
const Placement = Schema.Struct({
	sessionID: Session.ID,
	worktree: Schema.String,
	directory: Schema.String,
	initializeModel: Schema.Boolean,
})
export type UnitPlacement = typeof Placement.Type

type PlacedSession = {
	readonly id: string
	readonly location: { readonly directory: string }
	readonly metadata?: Readonly<Record<string, unknown>> | undefined
}

/** A Unit's worktree placement, once the session has moved into it. */
export function completedUnitPlacement(session: PlacedSession): Option.Option<UnitPlacement> {
	return Schema.decodeUnknownOption(Placement)(session.metadata?.[metadataKey]).pipe(
		Option.filter(
			(placement) =>
				placement.sessionID === session.id && placement.directory === session.location.directory,
		),
	)
}

// The native subagent schema remains the input boundary. The registry erases
// its TypeScript input type when exposing an executable to other plugins.
interface SubagentInput {
	agent: string
	description: string
	prompt: string
	model?: string
	sessionID?: string
	background?: boolean
}

export const registerUnits = Effect.fn('registerUnits')(function* (ctx: Plugin.Context) {
	// A moved session can reach its destination before its plugins finish loading.
	// Prompt admission waits for activation, so resolve the destination's complete
	// Unit configuration here, before the initial brief can start model execution.
	yield* ctx.session.hook('prompt', (event) =>
		Effect.gen(function* () {
			const session = yield* ctx.session.get({ sessionID: event.sessionID })
			if (session.agent !== 'unit') return
			const placement = Schema.decodeUnknownOption(Placement)(session.metadata?.[metadataKey])
			if (
				placement._tag === 'None' ||
				placement.value.sessionID !== session.id ||
				!placement.value.initializeModel
			)
				return
			const { data: unit } = yield* ctx.agent.get({ agentID: Agent.ID.make('unit') })
			if (unit.model) yield* ctx.session.switchModel({ sessionID: session.id, model: unit.model })
			yield* ctx.session.update({
				sessionID: session.id,
				metadata: {
					...session.metadata,
					[metadataKey]: { ...placement.value, initializeModel: false },
				},
			})
		}).pipe(Effect.orDie),
	)

	yield* ctx.tool.transform((editor) => {
		const native = editor.get('subagent')
		if (!native) return
		const execute = native.execute
		editor.update('subagent', (tool) => {
			tool.description += '\nNew unit subagents run in their own OpenCode-managed worktrees.'
			tool.execute = (input, context) => {
				const args = input as SubagentInput
				if (args.agent !== 'unit') return execute(input, context)
				if (ctx.app.version !== placementVersion)
					return Effect.fail(
						new Tool.Error({
							message: `Native Unit placement requires OpenCode ${placementVersion}; this host runs ${ctx.app.version}`,
						}),
					)
				const continuedSessionID = args.sessionID
				if (continuedSessionID)
					return Effect.gen(function* () {
						const child = yield* ctx.session
							.get({ sessionID: Session.ID.make(continuedSessionID) })
							.pipe(
								Effect.mapError(
									(error) =>
										new Tool.Error({
											message: `Unit session not found: ${continuedSessionID}`,
											error,
										}),
								),
							)
						const placement = completedUnitPlacement(child)
						if (placement._tag === 'None')
							return yield* new Tool.Error({
								message: `Unit ${child.id} has no completed worktree placement. Inspect it before continuing.`,
							})
						if (args.model === undefined || !placement.value.initializeModel)
							return yield* execute(input, context)
						return yield* execute(input, {
							...context,
							progress: (update) =>
								Effect.gen(function* () {
									yield* context.progress(update)
									// Native continuation has now authorized the call and applied
									// its explicit model. Do not replace it at prompt admission.
									const current = yield* ctx.session.get({ sessionID: child.id })
									yield* ctx.session.update({
										sessionID: child.id,
										metadata: {
											...current.metadata,
											[metadataKey]: { ...placement.value, initializeModel: false },
										},
									})
								}).pipe(Effect.orDie),
						})
					})
				let childID: Session.ID | undefined
				let worktree: string | undefined
				let targetDirectory: string | undefined
				return execute(input, {
					...context,
					progress: (update) =>
						Effect.gen(function* () {
							yield* context.progress(update)
							if (childID !== undefined) return
							childID = yield* Schema.decodeUnknownEffect(Session.ID)(update.sessionID).pipe(
								Effect.orDie,
							)
							const child = yield* ctx.session.get({ sessionID: childID })
							if (child.parentID !== context.sessionID)
								return yield* new Tool.Error({
									message: 'Unit is not a child of the calling session',
								})
							const parent = yield* ctx.session.get({ sessionID: context.sessionID })
							// OpenCode 2.1.4 awaits this progress call after its permission,
							// depth and model checks, but before admitting the child's prompt.
							// Keep that native new-child path, including admit-only background
							// prompts and native Job recovery, instead of precreating a child.
							const created = yield* ctx.worktree.create({
								projectID: ctx.location.project.id,
								from: ctx.location.project.directory,
								name: `unit-${childID}`,
							})
							worktree = created.directory
							const directory = AbsolutePath.make(join(created.directory, parent.subpath ?? ''))
							targetDirectory = directory
							yield* ctx.session.update({
								sessionID: childID,
								metadata: {
									...child.metadata,
									[metadataKey]: {
										sessionID: childID,
										worktree,
										directory,
										initializeModel: args.model === undefined,
									},
								},
							})
							yield* ctx.session.move({ sessionID: childID, directory })
							yield* ctx.session.wait({ sessionID: childID })
							const placed = yield* ctx.session.get({ sessionID: childID })
							if (placed.location.directory !== directory)
								return yield* new Tool.Error({ message: 'Unit did not move to its worktree' })
							yield* context.progress({ ...update, worktree, directory })
						}).pipe(
							Effect.mapError(
								(error) =>
									new Tool.Error({
										message: `Unit worktree setup failed (sessionID: ${childID}${worktree ? `, worktree: ${worktree}` : ''}${targetDirectory && targetDirectory !== worktree ? `, directory: ${targetDirectory}` : ''}): ${error instanceof Error && error.message ? error.message : String(error)}. Inspect the child and native worktree inventory before retrying.`,
										error,
									}),
							),
							Effect.orDie,
						),
				})
			}
		})
	})
})
