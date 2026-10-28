import { Schema } from 'effect'
import { RESERVED_MARKER, ReportResult, ReviewDecision } from './schema'

// A card stores its board metadata in one visible fenced JSON block of the
// issue description, below a readable rendering of the latest report and
// review. Everything outside that managed section belongs to people and is
// preserved on every write. The block is cooperative state, not tamperproof:
// anyone who can edit the issue can edit it, so readers validate it strictly
// and reject anything ambiguous instead of repairing ownership.

export const METADATA_KIND = RESERVED_MARKER
export const METADATA_VERSION = 1
export const MANAGED_HEADING = 'Limitless task board'

export function ownerMarker(leadSessionID: string): string {
	return `${RESERVED_MARKER}:v${METADATA_VERSION}:lead:${leadSessionID}`
}

export const UnitClaim = Schema.Struct({
	sessionID: Schema.String,
	worktree: Schema.String,
	directory: Schema.String,
})
export type UnitClaim = typeof UnitClaim.Type

export const CardMetadata = Schema.Struct({
	kind: Schema.Literal(METADATA_KIND),
	version: Schema.Literal(METADATA_VERSION),
	taskId: Schema.String,
	owner: Schema.String,
	lead: Schema.Struct({ sessionID: Schema.String }),
	unit: Schema.NullOr(UnitClaim),
	blocked: Schema.Boolean,
	report: Schema.NullOr(
		Schema.Struct({
			result: ReportResult,
			summary: Schema.String,
			reportedAt: Schema.String,
			superseded: Schema.Boolean,
		}),
	),
	review: Schema.NullOr(
		Schema.Struct({
			decision: ReviewDecision,
			note: Schema.optional(Schema.String),
			reviewedAt: Schema.String,
		}),
	),
})
export type CardMetadata = typeof CardMetadata.Type

export function newCardMetadata(taskId: string, leadSessionID: string): CardMetadata {
	return {
		kind: METADATA_KIND,
		version: METADATA_VERSION,
		taskId,
		owner: ownerMarker(leadSessionID),
		lead: { sessionID: leadSessionID },
		unit: null,
		blocked: false,
		report: null,
		review: null,
	}
}

export type CardDocument = {
	readonly metadata: CardMetadata
	/** Human-owned text before and after the managed section. */
	readonly before: string
	readonly after: string
}

export type CardDocumentResult =
	| { readonly ok: true; readonly document: CardDocument }
	| { readonly ok: false; readonly problem: string }

type FencedBlock = {
	readonly fence: string
	readonly start: number
	readonly end: number
	readonly closed: boolean
	readonly content: string
}

const fenceOpener = /^ {0,3}(`{3,}|~{3,})(.*)$/u
const fenceCloser = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u
const managedHeading = new RegExp(`^ {0,3}#{1,6}[ \\t]+${MANAGED_HEADING}[ \\t]*#*[ \\t]*$`, 'iu')

function closesFence(line: string, fence: string): boolean {
	const closer = fenceCloser.exec(line)?.[1]
	return closer !== undefined && closer[0] === fence[0] && closer.length >= fence.length
}

/** Top-level fenced code blocks, as CommonMark reads them; quotes cannot open one. */
function fencedBlocks(lines: ReadonlyArray<string>): Array<FencedBlock> {
	const blocks: Array<FencedBlock> = []
	for (let index = 0; index < lines.length; index++) {
		const opener = fenceOpener.exec(lines[index] ?? '')
		const fence = opener?.[1]
		if (fence === undefined) continue
		// A backtick fence's info string cannot contain backticks.
		if (fence[0] === '`' && (opener?.[2] ?? '').includes('`')) continue
		let end = index + 1
		while (end < lines.length && !closesFence(lines[end] ?? '', fence)) end++
		blocks.push({
			fence,
			start: index,
			end: Math.min(end, lines.length - 1),
			closed: end < lines.length,
			content: lines.slice(index + 1, end).join('\n'),
		})
		index = end
	}
	return blocks
}

function managedPayload(content: string): unknown {
	try {
		const value: unknown = JSON.parse(content)
		return typeof value === 'object' &&
			value !== null &&
			Reflect.get(value, 'kind') === METADATA_KIND
			? value
			: undefined
	} catch {
		return undefined
	}
}

/** Parses a card description, validating its single managed block against the issue. */
export function parseCardDescription(description: string, issueId: string): CardDocumentResult {
	const lines = splitLines(description)
	const blocks = fencedBlocks(lines)
	const managed = blocks.flatMap((block) => {
		const payload = managedPayload(block.content)
		return payload === undefined ? [] : [{ block, payload }]
	})
	const [match, duplicate] = managed
	if (match === undefined) return { ok: false, problem: 'The card has no task board metadata.' }
	if (duplicate !== undefined)
		return { ok: false, problem: 'The card has more than one task board metadata block.' }
	if (Reflect.get(match.payload as object, 'version') !== METADATA_VERSION)
		return { ok: false, problem: 'The card uses an unsupported task board metadata version.' }
	const decoded = Schema.decodeUnknownOption(CardMetadata)(match.payload)
	if (decoded._tag === 'None')
		return { ok: false, problem: 'The card has invalid task board metadata.' }
	const metadata = decoded.value
	if (metadata.taskId.toLowerCase() !== issueId.toLowerCase())
		return { ok: false, problem: 'The card metadata belongs to a different task.' }
	if (metadata.owner !== ownerMarker(metadata.lead.sessionID))
		return { ok: false, problem: 'The card metadata has an inconsistent owner.' }

	const previousEnd = blocks
		.filter((block) => block.end < match.block.start)
		.reduce((last, block) => Math.max(last, block.end), -1)
	let start = match.block.start
	for (let index = match.block.start - 1; index > previousEnd; index--) {
		if (managedHeading.test(lines[index] ?? '')) {
			start = index
			break
		}
	}
	return {
		ok: true,
		document: {
			metadata,
			before: humanText(lines.slice(0, start)),
			after: humanText(lines.slice(match.block.end + 1)),
		},
	}
}

/** Drops only surrounding blank lines; indentation can carry Markdown meaning. */
function humanText(lines: ReadonlyArray<string>): string {
	const isBlank = (line: string | undefined) => line !== undefined && line.trim().length === 0
	let start = 0
	let end = lines.length
	while (start < end && isBlank(lines[start])) start++
	while (end > start && isBlank(lines[end - 1])) end--
	return lines.slice(start, end).join('\n')
}

function quote(text: string): string {
	return splitLines(text)
		.map((line) => (line.length === 0 ? '>' : `> ${line}`))
		.join('\n')
}

function renderManagedSection(metadata: CardMetadata): string {
	const report = metadata.report
	const review = metadata.review
	const lines = [`## ${MANAGED_HEADING}`, '']
	if (report === null) lines.push('No Unit report yet.', '')
	else {
		const label = report.superseded ? 'Previous Unit report' : 'Latest Unit report'
		const detail = report.superseded
			? 'superseded by a Lead continue'
			: report.result === 'blocked'
				? 'waiting for a Lead decision'
				: 'ready for Lead review'
		lines.push(
			`**${label}:** ${report.result}, ${report.reportedAt} (${detail})`,
			'',
			quote(report.summary),
			'',
		)
	}
	if (review !== null) {
		lines.push(`**Lead review:** ${review.decision}, ${review.reviewedAt}`, '')
		if (review.note !== undefined) lines.push(quote(review.note), '')
	}
	// Model-supplied text above is quoted, so it cannot open a heading or fence.
	lines.push('```json', JSON.stringify(metadata, null, 2), '```')
	return lines.join('\n')
}

function splitLines(text: string): Array<string> {
	return text.replace(/\r\n?/gu, '\n').split('\n')
}

/** Closes a trailing unterminated fence so it cannot swallow the managed block. */
function closeOpenFence(text: string): string {
	const last = fencedBlocks(splitLines(text)).at(-1)
	return last === undefined || last.closed ? text : `${text}\n${last.fence}`
}

/** Renders a card description, replacing only the managed section. */
export function renderCardDescription(document: CardDocument): string {
	return [closeOpenFence(document.before), renderManagedSection(document.metadata), document.after]
		.filter((part) => part.length > 0)
		.join('\n\n')
}

/** Human-owned description text, which starts as the Lead's assignment summary. */
export function assignmentText(document: CardDocument): string {
	return [document.before, document.after].filter((part) => part.length > 0).join('\n\n')
}
