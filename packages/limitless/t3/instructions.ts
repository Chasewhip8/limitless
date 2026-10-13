import { readFile } from 'node:fs/promises'
import type { SessionRequest } from '@opencode/plugin/effect/session'
import { Effect, Schema } from 'effect'

// The bridge replaces the original entry with a neutral marker before persistence.
// Native children inherit the permission binding, not instruction entries.
export const T3_CONTEXT = '<!-- limitless:t3-context:v1 -->'

export class T3GuidanceError extends Schema.TaggedError<T3GuidanceError>()('T3GuidanceError', {
	message: Schema.String,
}) {}

export const loadT3Guidance = () =>
	Effect.tryPromise({
		try: async () => ({
			primary: (await readFile(new URL('./prompts/primary.md', import.meta.url), 'utf8')).trim(),
			support: (await readFile(new URL('./prompts/support.md', import.meta.url), 'utf8')).trim(),
		}),
		catch: () =>
			new T3GuidanceError({ message: 'Unable to read the packaged T3 guidance templates' }),
	})

type InstructionRequest = Pick<SessionRequest, 'system' | 'messages'>

export function hasT3Context(request: InstructionRequest): boolean {
	return (
		request.system.some((part) => part.text.includes(T3_CONTEXT)) ||
		request.messages.some(
			(message) =>
				message.role === 'system' &&
				message.content.some((part) => part.type === 'text' && part.text.includes(T3_CONTEXT)),
		)
	)
}

export function injectT3Guidance(
	request: InstructionRequest,
	guidance: string,
	appendWhenMissing = false,
): void {
	if (!hasT3Context(request)) {
		if (appendWhenMissing && !request.system.some((part) => part.text === guidance)) {
			request.system = [...request.system, { type: 'text', text: guidance }]
		}
		return
	}
	request.system = request.system.map((part) => ({
		...part,
		text: part.text.replaceAll(T3_CONTEXT, guidance),
	}))
	request.messages = request.messages.map((message) =>
		message.role !== 'system'
			? message
			: {
					...message,
					content: message.content.map((part) =>
						part.type !== 'text'
							? part
							: { ...part, text: part.text.replaceAll(T3_CONTEXT, guidance) },
					),
				},
	)
}
