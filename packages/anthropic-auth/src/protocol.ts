import { AnthropicMessages } from '@opencode-ai/ai/protocols/anthropic-messages'
import { Protocol } from '@opencode-ai/ai/route'
import { Effect } from 'effect'
import { transformAnthropicBody, transformStreamEvent } from './transform'

export const maxOAuthProtocol = Protocol.make({
	id: 'limitless-anthropic-max-messages',
	body: {
		schema: AnthropicMessages.AnthropicMessagesBody,
		from: (request) =>
			AnthropicMessages.protocol.body.from(request).pipe(Effect.map(transformAnthropicBody)),
	},
	stream: {
		event: AnthropicMessages.protocol.stream.event,
		initial: AnthropicMessages.protocol.stream.initial,
		step: (state, event) =>
			AnthropicMessages.protocol.stream.step(state, transformStreamEvent(event)),
	},
})
