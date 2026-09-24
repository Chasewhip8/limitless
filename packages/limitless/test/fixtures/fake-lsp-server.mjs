import { appendFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const logPath = process.env.FAKE_LSP_LOG
function log(event) {
	if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify(event)}\n`)
}

const pidPath = process.env.FAKE_LSP_PID_FILE
if (pidPath !== undefined) writeFileSync(pidPath, String(process.pid))
process.on('exit', (code) => log({ event: 'processExit', code }))
if (process.env.FAKE_LSP_IGNORE_EXIT === '1') setInterval(() => undefined, 60_000)
if (process.env.FAKE_LSP_IGNORE_SIGTERM === '1') {
	process.on('SIGTERM', () => log({ event: 'ignoredSigterm' }))
}
const holdReferences = process.env.FAKE_LSP_HOLD_REFERENCES === '1'
const lateResponse = process.env.FAKE_LSP_LATE_RESPONSE === '1'
let input = Buffer.alloc(0)
let nextId = 100
let openedUri
let workspaceFileUri = pathToFileURL(`${process.cwd()}/sample.ts`).href
const preparedHierarchyItemsById = new Map()
const pendingReferences = new Set()
const lateResponses = new Set()
const fooRange = {
	start: { line: 0, character: 6 },
	end: { line: 0, character: 9 },
}
const lineOneFooRange = {
	start: { line: 1, character: 0 },
	end: { line: 1, character: 3 },
}
const lineOneSecondFooRange = {
	start: { line: 1, character: 6 },
	end: { line: 1, character: 9 },
}
function isObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function property(value, key) {
	return isObject(value) ? Reflect.get(value, key) : undefined
}
function write(message) {
	log({ direction: 'serverToClient', message })
	const body = JSON.stringify(message)
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
}
function respond(id, result) {
	write({ jsonrpc: '2.0', id, result })
}
function respondError(id, code, message) {
	write({ jsonrpc: '2.0', id, error: { code, message } })
}
// Real servers ask the client for configuration; the client must answer without stalling.
function requestConfiguration() {
	write({ jsonrpc: '2.0', id: nextId, method: 'workspace/configuration', params: { items: [{}] } })
	nextId += 1
}
function updateWorkspaceFileUri(params) {
	const rootUri = property(params, 'rootUri')
	if (typeof rootUri === 'string') {
		const base = rootUri.endsWith('/') ? rootUri : `${rootUri}/`
		workspaceFileUri = new URL('sample.ts', base).href
	}
}
function capabilities() {
	return {
		definitionProvider: true,
		...(process.env.FAKE_LSP_NO_DECLARATION_CAPABILITY === '1'
			? {}
			: { declarationProvider: true }),
		typeDefinitionProvider: true,
		hoverProvider: true,
		callHierarchyProvider: true,
		referencesProvider: true,
		documentSymbolProvider: true,
		renameProvider: { prepareProvider: true },
	}
}
function uriFromParams(params) {
	const uri = property(property(params, 'textDocument'), 'uri')
	return typeof uri === 'string' ? uri : undefined
}
function currentUri(params) {
	return openedUri ?? uriFromParams(params) ?? workspaceFileUri
}
function referenceResult(params) {
	const uri = currentUri(params)
	return [
		{ uri, range: fooRange },
		{ targetUri: uri, targetRange: lineOneFooRange, targetSelectionRange: lineOneFooRange },
	]
}
function definitionResult(params) {
	const uri = currentUri(params)
	// Spells the first location's URI differently so deduplication must normalize it.
	const equivalentUri = uri.replace(/^file:\/\//u, 'file:')
	return [
		{ uri, range: fooRange },
		{ uri: equivalentUri, range: fooRange },
		{ uri, range: lineOneFooRange },
	]
}
function declarationResult(params) {
	const uri = currentUri(params)
	return [
		{
			targetUri: uri,
			targetRange: fooRange,
			targetSelectionRange: fooRange,
			originSelectionRange: fooRange,
		},
		{ targetUri: uri, targetRange: lineOneFooRange, targetSelectionRange: lineOneFooRange },
	]
}
function typeDefinitionResult(params) {
	const uri = currentUri(params)
	return [
		{ targetUri: uri, targetRange: lineOneFooRange, targetSelectionRange: lineOneFooRange },
		{
			targetUri: uri,
			targetRange: lineOneSecondFooRange,
			targetSelectionRange: lineOneSecondFooRange,
		},
	]
}
function hoverResult() {
	if (process.env.FAKE_LSP_HOVER_MODE === 'markup-markdown') {
		return { contents: { kind: 'markdown', value: '**foo** docs' }, range: fooRange }
	}
	return {
		contents: ['**legacy foo**', { language: 'typescript', value: 'const foo: number' }],
		range: fooRange,
	}
}
function hierarchyItem(name, id, range) {
	return {
		name,
		kind: 12,
		tags: [1],
		detail: `${name} detail`,
		uri: workspaceFileUri,
		range,
		selectionRange: range,
		data: { id, token: `opaque-${id}`, nested: { preserve: true } },
		serverExtension: { exact: id },
	}
}
function preparedHierarchyItems() {
	preparedHierarchyItemsById.clear()
	const items = [
		hierarchyItem('foo', 'foo', fooRange),
		hierarchyItem('bar', 'bar', lineOneFooRange),
	]
	for (const item of items) preparedHierarchyItemsById.set(item.data.id, item)
	return items
}
// Follow-up requests must echo the exact prepared item, including opaque server data.
function hierarchyItemId(params) {
	const item = property(params, 'item')
	const id = property(property(item, 'data'), 'id')
	const preparedItem = preparedHierarchyItemsById.get(id)
	if (preparedItem === undefined || JSON.stringify(item) !== JSON.stringify(preparedItem)) {
		return undefined
	}
	return id
}
function incomingCallResult(id) {
	const range = id === 'foo' ? lineOneSecondFooRange : fooRange
	return [{ from: hierarchyItem(`caller-${id}`, `caller-${id}`, range), fromRanges: [range] }]
}
function outgoingCallResult(id) {
	const range = id === 'foo' ? lineOneFooRange : lineOneSecondFooRange
	return [
		{
			to: hierarchyItem(`callee-${id}`, `callee-${id}`, range),
			fromRanges: [id === 'foo' ? fooRange : lineOneFooRange],
		},
	]
}
function respondWithHierarchyCalls(id, params, calls) {
	const hierarchyId = hierarchyItemId(params)
	if (hierarchyId === undefined) {
		respondError(id, -32602, 'prepared hierarchy item was not preserved')
		return
	}
	respond(id, calls(hierarchyId))
}
function respondUnlessForcedError(id, variable, message, result) {
	if (process.env[variable] === '1') respondError(id, -32603, message)
	else respond(id, result)
}
function handleRequest(id, method, params) {
	if (method === 'initialize') {
		updateWorkspaceFileUri(params)
		respond(id, { capabilities: capabilities() })
		requestConfiguration()
		return
	}
	if (method === 'shutdown') {
		respond(id, null)
		return
	}
	if (method === 'textDocument/references') {
		if (holdReferences) pendingReferences.add(id)
		else respond(id, referenceResult(params))
		const marker = process.env.FAKE_LSP_REQUEST_MARKER
		if (marker !== undefined) writeFileSync(marker, 'dispatched')
		return
	}
	if (method === 'textDocument/definition') {
		respondUnlessForcedError(
			id,
			'FAKE_LSP_DEFINITION_ERROR',
			'forced definition failure',
			definitionResult(params),
		)
		return
	}
	if (method === 'textDocument/declaration') {
		respondUnlessForcedError(
			id,
			'FAKE_LSP_DECLARATION_ERROR',
			'forced declaration failure',
			declarationResult(params),
		)
		return
	}
	if (method === 'textDocument/typeDefinition') {
		respondUnlessForcedError(
			id,
			'FAKE_LSP_TYPE_DEFINITION_ERROR',
			'forced type definition failure',
			typeDefinitionResult(params),
		)
		return
	}
	if (method === 'textDocument/hover') {
		respond(id, hoverResult())
		return
	}
	if (method === 'textDocument/prepareCallHierarchy') {
		respond(id, preparedHierarchyItems())
		return
	}
	if (method === 'callHierarchy/incomingCalls') {
		respondWithHierarchyCalls(id, params, incomingCallResult)
		return
	}
	if (method === 'callHierarchy/outgoingCalls') {
		respondWithHierarchyCalls(id, params, outgoingCallResult)
		return
	}
	if (method === 'textDocument/documentSymbol') {
		respond(id, [
			{
				name: 'foo',
				kind: 12,
				range: { start: { line: 0, character: 0 }, end: { line: 1, character: 9 } },
				selectionRange: fooRange,
				children: [
					{ name: 'bar', kind: 12, range: lineOneFooRange, selectionRange: lineOneFooRange },
				],
			},
		])
		return
	}
	if (method === 'textDocument/prepareRename') {
		respond(id, fooRange)
		return
	}
	if (method === 'textDocument/rename') {
		const uri = currentUri(params)
		const newName = property(params, 'newName')
		const edit = { range: fooRange, newText: typeof newName === 'string' ? newName : '' }
		respond(id, {
			changes: { [uri]: [edit] },
			documentChanges: [{ textDocument: { uri, version: 1 }, edits: [edit] }],
		})
		return
	}
	respondError(id, -32601, `Unsupported method: ${method}`)
}
function handleCancellation(params) {
	const id = property(params, 'id')
	if (!pendingReferences.delete(id)) return
	// A late response arriving after didClose must not be mistaken for a live request.
	if (lateResponse) lateResponses.add(id)
	else respondError(id, -32800, 'Request cancelled')
}
function flushLateResponses() {
	for (const id of lateResponses) respond(id, [])
	lateResponses.clear()
}
function handleNotification(method, params) {
	if (method === 'textDocument/didOpen') openedUri = uriFromParams(params)
	if (method === '$/cancelRequest') handleCancellation(params)
	if (method === 'textDocument/didClose') flushLateResponses()
	if (method === 'exit' && process.env.FAKE_LSP_IGNORE_EXIT !== '1') process.exit(0)
}
function handleMessage(body) {
	let message
	try {
		message = JSON.parse(body)
	} catch {
		return
	}
	if (!isObject(message)) return
	log({ direction: 'clientToServer', message })
	const method = property(message, 'method')
	const id = property(message, 'id')
	if (typeof method !== 'string') return
	if (typeof id === 'number' || typeof id === 'string')
		handleRequest(id, method, property(message, 'params'))
	else handleNotification(method, property(message, 'params'))
}
process.stdin.on('data', (chunk) => {
	input = Buffer.concat([input, chunk])
	while (true) {
		const headerEnd = input.indexOf('\r\n\r\n')
		if (headerEnd === -1) return
		const header = input.subarray(0, headerEnd).toString('ascii')
		const lengthMatch = /^Content-Length:\s*(\d+)$/imu.exec(header)
		if (lengthMatch === null) {
			input = input.subarray(headerEnd + 4)
			continue
		}
		const length = Number(lengthMatch[1])
		const bodyStart = headerEnd + 4
		const bodyEnd = bodyStart + length
		if (input.length < bodyEnd) return
		const body = input.subarray(bodyStart, bodyEnd).toString('utf8')
		input = input.subarray(bodyEnd)
		handleMessage(body)
	}
})
