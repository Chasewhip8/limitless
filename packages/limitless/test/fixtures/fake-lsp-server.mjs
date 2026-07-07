import { pathToFileURL } from 'node:url'

if (process.env.FAKE_LSP_EXIT_EARLY === '1') process.exit(1)
const delayMs = Number(process.env.FAKE_LSP_DELAY_MS ?? '0') || 0
let input = Buffer.alloc(0)
let nextId = 1
let openedUri
let workspaceFileUri = pathToFileURL(`${process.cwd()}/sample.ts`).href
const fooRange = {
	start: { line: 0, character: 6 },
	end: { line: 0, character: 9 },
}
const lineOneFooRange = {
	start: { line: 1, character: 0 },
	end: { line: 1, character: 3 },
}
function isObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function property(value, key) {
	return isObject(value) ? Reflect.get(value, key) : undefined
}
function write(message) {
	const body = JSON.stringify(message)
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
}
function send(message, after) {
	if (delayMs > 0) {
		setTimeout(() => {
			write(message)
			after?.()
		}, delayMs)
		return
	}
	write(message)
	after?.()
}
function respond(id, result, after) {
	send({ jsonrpc: '2.0', id, result }, after)
}
function respondError(id, code, message) {
	send({ jsonrpc: '2.0', id, error: { code, message } })
}
function requestConfiguration() {
	write({
		jsonrpc: '2.0',
		id: nextId,
		method: 'workspace/configuration',
		params: { items: [{}] },
	})
	nextId += 1
}
function updateWorkspaceFileUri(params) {
	const rootUri = property(params, 'rootUri')
	if (typeof rootUri !== 'string') return
	const base = rootUri.endsWith('/') ? rootUri : `${rootUri}/`
	workspaceFileUri = new URL('sample.ts', base).href
}
function capabilities() {
	return {
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
function handleRequest(id, method, params) {
	if (method === 'initialize') {
		updateWorkspaceFileUri(params)
		respond(id, { capabilities: capabilities() }, requestConfiguration)
		return
	}
	if (method === 'shutdown') {
		respond(id, null)
		return
	}
	if (method === 'textDocument/references') {
		const uri = currentUri(params)
		respond(id, [
			{ uri, range: fooRange },
			{ targetUri: uri, targetRange: lineOneFooRange, targetSelectionRange: lineOneFooRange },
		])
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
function handleNotification(method, params) {
	if (method === 'textDocument/didOpen') openedUri = uriFromParams(params)
	if (method === 'exit') process.exit(0)
}
function handleMessage(body) {
	let message
	try {
		message = JSON.parse(body)
	} catch {
		return
	}
	if (!isObject(message)) return
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
