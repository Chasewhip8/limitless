import type { Data } from '@opencode/plugin/tui/context'

type Message = ReturnType<Data['session']['message']['list']>[number]
type Assistant = Extract<Message, { type: 'assistant' }>

const MINUTE = 60_000

/**
 * Provider prompt-cache lifetimes for the request shapes OpenCode sends.
 * Anthropic: OpenCode places 5-minute ephemeral breakpoints and exposes no 1-hour option.
 * OpenAI: GPT-5.6+ guarantees at least 30 minutes after the latest write or reuse.
 */
export const cacheLifetimes: Readonly<Record<string, number>> = {
	anthropic: 5 * MINUTE,
	openai: 30 * MINUTE,
}

export type CacheStatus =
	| { readonly state: 'warm'; readonly expiresAt?: number }
	| { readonly state: 'cold' }
	| { readonly state: 'unknown' }

/** Returns undefined until the session has made a model request worth tracking. */
export function cacheStatus(input: {
	readonly messages: readonly Message[]
	readonly running: boolean
	readonly now: number
}): CacheStatus | undefined {
	const last = latestAssistant(input.messages)
	if (!last) return undefined

	const lifetime = cacheLifetimes[last.model.providerID]
	if (lifetime === undefined) return { state: 'unknown' }
	// An in-flight request writes or refreshes the cached prefix.
	if (input.running) return { state: 'warm' }

	const expiresAt = (last.time.completed ?? last.time.created) + lifetime
	return input.now < expiresAt ? { state: 'warm', expiresAt } : { state: 'cold' }
}

function latestAssistant(messages: readonly Message[]): Assistant | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (message?.type === 'assistant') return message
	}
	return undefined
}
