import { createHash } from 'node:crypto'
import { CCH_POSITIONS, CCH_SALT, CLAUDE_CODE_VERSION } from './constants'

export type BillingMessage = {
	readonly role?: string
	readonly content?: string | ReadonlyArray<{ readonly type?: string; readonly text?: string }>
}

export function extractFirstUserMessageText(messages: ReadonlyArray<BillingMessage>): string {
	const message = messages.find((candidate) => candidate.role === 'user')
	if (!message) return ''
	if (typeof message.content === 'string') return message.content
	return message.content?.find((block) => block.type === 'text')?.text ?? ''
}

export function computeCCH(messageText: string): string {
	return createHash('sha256').update(messageText).digest('hex').slice(0, 5)
}

export function computeVersionSuffix(
	messageText: string,
	version: string = CLAUDE_CODE_VERSION,
): string {
	const characters = CCH_POSITIONS.map((index) => messageText[index] || '0').join('')
	return createHash('sha256').update(`${CCH_SALT}${characters}${version}`).digest('hex').slice(0, 3)
}

export function buildBillingHeaderValue(
	messages: ReadonlyArray<BillingMessage>,
	version: string = CLAUDE_CODE_VERSION,
	entrypoint: string,
): string {
	const text = extractFirstUserMessageText(messages)
	return (
		'x-anthropic-billing-header: ' +
		`cc_version=${version}.${computeVersionSuffix(text, version)}; ` +
		`cc_entrypoint=${entrypoint}; ` +
		`cch=${computeCCH(text)};`
	)
}
