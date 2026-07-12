import { appendFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
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
if (process.env.FAKE_LSP_EXIT_EARLY === '1') process.exit(1)
const delayMs = Number(process.env.FAKE_LSP_DELAY_MS ?? '0') || 0
const exerciseClient = process.env.FAKE_LSP_EXERCISE_CLIENT === '1'
const holdReferences = process.env.FAKE_LSP_HOLD_REFERENCES === '1'
const lateResponse = process.env.FAKE_LSP_LATE_RESPONSE === '1'
const stallAfterInitialize = process.env.FAKE_LSP_STALL_AFTER_INITIALIZE === '1'
if (stallAfterInitialize) setInterval(() => undefined, 60_000)
if (process.env.FAKE_LSP_LOG_SIGTERM === '1') {
	process.on('SIGTERM', () => {
		log({ event: 'receivedSigterm' })
		process.exit(0)
	})
}
let input = Buffer.alloc(0)
let nextId = 100
let openedUri
let workspaceFileUri = pathToFileURL(`${process.cwd()}/sample.ts`).href
let currentWorkspaceFolder = {
	uri: pathToFileURL(process.cwd()).href,
	name: path.basename(process.cwd()),
}
let clientChecksComplete = !exerciseClient
const clientChecks = new Map()
const clientCheckErrors = []
const preparedHierarchyItemsById = new Map()
const pendingReferences = new Map()
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
function write(message, onFlushed) {
	log({ direction: 'serverToClient', message })
	const body = JSON.stringify(message)
	process.stdout.write(
		`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`,
		onFlushed,
	)
}
function send(message, after, delay = 0) {
	if (delay > 0) {
		setTimeout(() => {
			write(message)
			after?.()
		}, delay)
		return
	}
	write(message)
	after?.()
}
function respond(id, result, after, delay = 0) {
	send({ jsonrpc: '2.0', id, result }, after, delay)
}
function respondError(id, code, message) {
	send({ jsonrpc: '2.0', id, error: { code, message } })
}
function respondAndExit(id, result) {
	write({ jsonrpc: '2.0', id, result }, () => process.exit(0))
}
function requestClient(method, params, expected) {
	const id = nextId
	nextId += 1
	if (expected !== undefined) clientChecks.set(id, expected)
	write({ jsonrpc: '2.0', id, method, params })
}
function requestConfiguration() {
	requestClient('workspace/configuration', { items: [{}] })
}
function exerciseClientRequests() {
	write({
		jsonrpc: '2.0',
		method: 'window/logMessage',
		params: { type: 3, message: 'fixture notification' },
	})
	write({ jsonrpc: '2.0', method: 'fixture/unknownNotification', params: { ignored: true } })
	write({ jsonrpc: '2.0', method: '$/progress', params: { token: 'unknown', value: {} } })
	requestClient('workspace/configuration', { items: [{}, {}] }, 'configuration')
	requestClient('workspace/workspaceFolders', undefined, 'workspaceFolders')
	requestClient('client/registerCapability', { registrations: [] }, 'acknowledgement')
	requestClient('client/unregisterCapability', { unregisterations: [] }, 'acknowledgement')
	requestClient('window/workDoneProgress/create', { token: 'fixture' }, 'acknowledgement')
	requestClient('fixture/unknownRequest', {}, 'methodNotFound')
}
function updateWorkspaceFileUri(params) {
	const rootUri = property(params, 'rootUri')
	if (typeof rootUri === 'string') {
		const base = rootUri.endsWith('/') ? rootUri : `${rootUri}/`
		workspaceFileUri = new URL('sample.ts', base).href
	}
	const folders = property(params, 'workspaceFolders')
	const folder = Array.isArray(folders) ? folders[0] : undefined
	const uri = property(folder, 'uri')
	const name = property(folder, 'name')
	if (typeof uri === 'string' && typeof name === 'string') currentWorkspaceFolder = { uri, name }
}
function capabilities() {
	return {
		...(process.env.FAKE_LSP_NO_DEFINITION_CAPABILITY === '1' ? {} : { definitionProvider: true }),
		...(process.env.FAKE_LSP_NO_DECLARATION_CAPABILITY === '1'
			? {}
			: { declarationProvider: true }),
		...(process.env.FAKE_LSP_NO_TYPE_DEFINITION_CAPABILITY === '1'
			? {}
			: { typeDefinitionProvider: true }),
		...(process.env.FAKE_LSP_NO_HOVER_CAPABILITY === '1' ? {} : { hoverProvider: true }),
		...(process.env.FAKE_LSP_NO_IMPLEMENTATION_CAPABILITY === '1'
			? {}
			: { implementationProvider: true }),
		...(process.env.FAKE_LSP_NO_CALL_HIERARCHY_CAPABILITY === '1'
			? {}
			: { callHierarchyProvider: true }),
		...(process.env.FAKE_LSP_NO_REFERENCES_CAPABILITY === '1' ? {} : { referencesProvider: true }),
		documentSymbolProvider: true,
		workspaceSymbolProvider: true,
		renameProvider: { prepareProvider: true },
	}
}
function uriFromParams(params) {
	const textDocument = property(params, 'textDocument')
	const uri = property(textDocument, 'uri')
	return typeof uri === 'string' ? uri : undefined
}
function currentUri(params) {
	return openedUri ?? uriFromParams(params) ?? workspaceFileUri
}
function referenceResult(params) {
	if (process.env.FAKE_LSP_MALFORMED_REFERENCES === '1') return { invalid: true }
	const uri = currentUri(params)
	const locations = [
		{ uri, range: fooRange },
		{
			targetUri: uri,
			targetRange: lineOneFooRange,
			targetSelectionRange: lineOneFooRange,
		},
	]
	if (process.env.FAKE_LSP_DUPLICATE_REFERENCES === '1') locations.push(locations[0])
	return locations
}
function definitionResult(params) {
	if (process.env.FAKE_LSP_MALFORMED_DEFINITION === '1') return { invalid: true }
	const uri = currentUri(params)
	if (process.env.FAKE_LSP_DEFINITION_SINGULAR === '1') return { uri, range: fooRange }
	if (process.env.FAKE_LSP_DEFINITION_NULL === '1') return null
	if (process.env.FAKE_LSP_DEFINITION_EMPTY === '1') return []
	const equivalentUri = uri.replace(/^file:\/\//u, 'file:')
	return [
		{ uri, range: fooRange },
		{ uri: equivalentUri, range: fooRange },
		{ uri, range: lineOneFooRange },
	]
}
function declarationResult(params) {
	if (process.env.FAKE_LSP_MALFORMED_DECLARATION === '1') return { invalid: true }
	const uri = currentUri(params)
	const targetUri =
		process.env.FAKE_LSP_INVALID_DECLARATION_URI === '1' ? 'file:///%invalid-%' : uri
	return [
		{
			targetUri,
			targetRange: fooRange,
			targetSelectionRange: fooRange,
			originSelectionRange: fooRange,
		},
		{
			targetUri: uri,
			targetRange: lineOneFooRange,
			targetSelectionRange: lineOneFooRange,
		},
	]
}
function typeDefinitionResult(params) {
	if (process.env.FAKE_LSP_MALFORMED_TYPE_DEFINITION === '1') return { invalid: true }
	const uri = currentUri(params)
	return [
		{
			targetUri: uri,
			targetRange: lineOneFooRange,
			targetSelectionRange: lineOneFooRange,
		},
		{
			targetUri: uri,
			targetRange: lineOneSecondFooRange,
			targetSelectionRange: lineOneSecondFooRange,
		},
	]
}
function implementationResult(params) {
	if (process.env.FAKE_LSP_MALFORMED_IMPLEMENTATION === '1') return { invalid: true }
	const uri = currentUri(params)
	if (process.env.FAKE_LSP_IMPLEMENTATION_SINGULAR === '1') return { uri, range: fooRange }
	if (process.env.FAKE_LSP_IMPLEMENTATION_NULL === '1') return null
	if (process.env.FAKE_LSP_IMPLEMENTATION_EMPTY === '1') return []
	if (process.env.FAKE_LSP_IMPLEMENTATION_LOCATIONS === '1') {
		return [
			{ uri, range: fooRange },
			{ uri, range: fooRange },
			{ uri, range: lineOneSecondFooRange },
		]
	}
	return [
		{ targetUri: uri, targetRange: fooRange, targetSelectionRange: fooRange },
		{ targetUri: uri, targetRange: fooRange, targetSelectionRange: fooRange },
		{
			targetUri: uri,
			targetRange: lineOneSecondFooRange,
			targetSelectionRange: lineOneSecondFooRange,
		},
	]
}
function hoverResult() {
	if (process.env.FAKE_LSP_MALFORMED_HOVER === '1') return { contents: 42 }
	const mode = process.env.FAKE_LSP_HOVER_MODE
	if (mode === 'null') return null
	if (mode === 'markup-markdown') {
		return { contents: { kind: 'markdown', value: '**foo** docs' }, range: fooRange }
	}
	if (mode === 'markup-plaintext') {
		return { contents: { kind: 'plaintext', value: 'foo docs' }, range: fooRange }
	}
	if (mode === 'legacy-string') return { contents: '**legacy foo**', range: fooRange }
	if (mode === 'legacy-code') {
		return { contents: { language: 'typescript', value: 'const foo: number' }, range: fooRange }
	}
	if (mode === 'legacy-empty') return { contents: [] }
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
	if (process.env.FAKE_LSP_MALFORMED_CALL_PREPARE === '1') return [{ name: 42 }]
	if (process.env.FAKE_LSP_CALL_PREPARE_NULL === '1') return null
	if (process.env.FAKE_LSP_CALL_PREPARE_EMPTY === '1') return []
	const items = [
		hierarchyItem('foo', 'foo', fooRange),
		hierarchyItem('bar', 'bar', lineOneFooRange),
	]
	for (const item of items) preparedHierarchyItemsById.set(item.data.id, item)
	return items
}
function hierarchyItemId(params) {
	const item = property(params, 'item')
	const data = property(item, 'data')
	const id = property(data, 'id')
	const token = property(data, 'token')
	const nested = property(data, 'nested')
	const serverExtension = property(item, 'serverExtension')
	const preparedItem = preparedHierarchyItemsById.get(id)
	if (
		(id !== 'foo' && id !== 'bar') ||
		token !== `opaque-${id}` ||
		property(nested, 'preserve') !== true ||
		property(serverExtension, 'exact') !== id ||
		JSON.stringify(item) !== JSON.stringify(preparedItem)
	) {
		return undefined
	}
	return id
}
function incomingCallResult(id) {
	if (process.env.FAKE_LSP_MALFORMED_INCOMING_CALLS === '1') return [{ from: 42 }]
	if (process.env.FAKE_LSP_INCOMING_CALLS_NULL === '1') return null
	const range = id === 'foo' ? lineOneSecondFooRange : fooRange
	return [
		{
			from: hierarchyItem(`caller-${id}`, `caller-${id}`, range),
			fromRanges: [range],
		},
	]
}
function outgoingCallResult(id) {
	if (process.env.FAKE_LSP_MALFORMED_OUTGOING_CALLS === '1') return [{ to: 42 }]
	if (process.env.FAKE_LSP_OUTGOING_CALLS_NULL === '1') return null
	const range = id === 'foo' ? lineOneFooRange : lineOneSecondFooRange
	return [
		{
			to: hierarchyItem(`callee-${id}`, `callee-${id}`, range),
			fromRanges: [id === 'foo' ? fooRange : lineOneFooRange],
		},
	]
}
function completeReference(id, params) {
	if (!clientChecksComplete) {
		pendingReferences.set(id, params)
		return
	}
	if (clientCheckErrors.length > 0) {
		respondError(id, -32603, clientCheckErrors.join('; '))
		return
	}
	if (holdReferences) {
		pendingReferences.set(id, params)
		return
	}
	if (process.env.FAKE_LSP_EXIT_AFTER_REFERENCES_RESPONSE === '1') {
		const uri = currentUri(params)
		respondAndExit(id, [
			{
				uri,
				range: fooRange,
				padding: 'x'.repeat(4 * 1024 * 1024),
			},
		])
		return
	}
	respond(id, referenceResult(params), undefined, delayMs)
}
function handleRequest(id, method, params) {
	if (method === 'initialize') {
		updateWorkspaceFileUri(params)
		respond(id, { capabilities: capabilities() }, () => {
			if (stallAfterInitialize) process.stdin.pause()
			else if (exerciseClient) exerciseClientRequests()
			else requestConfiguration()
		})
		return
	}
	if (method === 'shutdown') {
		respond(id, null)
		return
	}
	if (method === 'textDocument/references') {
		if (process.env.FAKE_LSP_REFERENCES_ERROR === '1') {
			respondError(id, -32603, 'forced references failure')
			return
		}
		completeReference(id, params)
		const marker = process.env.FAKE_LSP_REQUEST_MARKER
		if (marker !== undefined) writeFileSync(marker, 'dispatched')
		return
	}
	if (method === 'textDocument/definition') {
		if (process.env.FAKE_LSP_DEFINITION_ERROR === '1') {
			respondError(id, -32603, 'forced definition failure')
			return
		}
		respond(id, definitionResult(params), undefined, delayMs)
		return
	}
	if (method === 'textDocument/declaration') {
		if (process.env.FAKE_LSP_DECLARATION_ERROR === '1') {
			respondError(id, -32603, 'forced declaration failure')
			return
		}
		respond(id, declarationResult(params), undefined, delayMs)
		return
	}
	if (method === 'textDocument/typeDefinition') {
		if (process.env.FAKE_LSP_TYPE_DEFINITION_ERROR === '1') {
			respondError(id, -32603, 'forced type definition failure')
			return
		}
		if (process.env.FAKE_LSP_HOLD_TYPE_DEFINITION === '1') return
		respond(id, typeDefinitionResult(params), undefined, delayMs)
		return
	}
	if (method === 'textDocument/hover') {
		if (process.env.FAKE_LSP_HOVER_ERROR === '1') {
			respondError(id, -32603, 'forced hover failure')
			return
		}
		respond(id, hoverResult(), undefined, delayMs)
		return
	}
	if (method === 'textDocument/implementation') {
		if (process.env.FAKE_LSP_IMPLEMENTATION_ERROR === '1') {
			respondError(id, -32603, 'forced implementation failure')
			return
		}
		respond(id, implementationResult(params), undefined, delayMs)
		return
	}
	if (method === 'textDocument/prepareCallHierarchy') {
		if (process.env.FAKE_LSP_CALL_PREPARE_ERROR === '1') {
			respondError(id, -32603, 'forced call hierarchy prepare failure')
			return
		}
		respond(id, preparedHierarchyItems(), undefined, delayMs)
		return
	}
	if (method === 'callHierarchy/incomingCalls') {
		if (process.env.FAKE_LSP_INCOMING_CALLS_ERROR === '1') {
			respondError(id, -32603, 'forced incoming calls failure')
			return
		}
		const hierarchyId = hierarchyItemId(params)
		if (hierarchyId === undefined) {
			respondError(id, -32602, 'prepared hierarchy item was not preserved')
			return
		}
		respond(id, incomingCallResult(hierarchyId), undefined, delayMs)
		return
	}
	if (method === 'callHierarchy/outgoingCalls') {
		if (process.env.FAKE_LSP_OUTGOING_CALLS_ERROR === '1') {
			respondError(id, -32603, 'forced outgoing calls failure')
			return
		}
		if (process.env.FAKE_LSP_HOLD_OUTGOING_CALLS === '1') return
		const hierarchyId = hierarchyItemId(params)
		if (hierarchyId === undefined) {
			respondError(id, -32602, 'prepared hierarchy item was not preserved')
			return
		}
		respond(id, outgoingCallResult(hierarchyId), undefined, delayMs)
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
					{
						name: 'bar',
						kind: 12,
						range: lineOneFooRange,
						selectionRange: lineOneFooRange,
					},
				],
			},
		])
		return
	}
	if (method === 'workspace/symbol') {
		respond(id, [
			{
				name: 'foo',
				kind: 12,
				location: { uri: currentUri(params), range: fooRange },
				containerName: 'fixture',
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
function finishClientChecks() {
	if (clientChecks.size > 0) return
	clientChecksComplete = true
	for (const [id, params] of pendingReferences) {
		pendingReferences.delete(id)
		completeReference(id, params)
	}
}
function handleResponse(message) {
	const id = property(message, 'id')
	if (typeof id !== 'number') return
	const expected = clientChecks.get(id)
	if (expected === undefined) return
	clientChecks.delete(id)
	const result = property(message, 'result')
	const error = property(message, 'error')
	if (expected === 'configuration' && JSON.stringify(result) !== '[null,null]') {
		clientCheckErrors.push(`workspace/configuration returned ${JSON.stringify(result)}`)
	}
	if (
		expected === 'workspaceFolders' &&
		JSON.stringify(result) !== JSON.stringify([currentWorkspaceFolder])
	) {
		clientCheckErrors.push(`workspace/workspaceFolders returned ${JSON.stringify(result)}`)
	}
	if (expected === 'acknowledgement' && result !== null) {
		clientCheckErrors.push(`request ${id} was not acknowledged with null`)
	}
	if (expected === 'methodNotFound' && property(error, 'code') !== -32601) {
		clientCheckErrors.push(`unknown request returned ${JSON.stringify(error)}`)
	}
	finishClientChecks()
}
function handleCancellation(params) {
	const id = property(params, 'id')
	if ((typeof id !== 'number' && typeof id !== 'string') || !pendingReferences.has(id)) return
	pendingReferences.delete(id)
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
	if (typeof method !== 'string') {
		handleResponse(message)
		return
	}
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
