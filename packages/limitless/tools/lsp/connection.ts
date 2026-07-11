import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Deferred, Effect, Queue, Ref, Result, Schema, Semaphore } from 'effect'
import { workspacePath } from '../../core/paths'
import { describeUnknown, schemaErrorMessage } from '../../lib/guards'
import {
	type LspServerConfig as LspServerConfigType,
	languageId,
	matchingServers,
	pathExtension,
} from './config'
import { decodeServerValue, type LspToolError, lspError } from './errors'
import type { LspConnectionRuntime, LspRuntimeEvent, LspRuntimeState } from './runtime'
import {
	JsonRpcErrorResponse,
	JsonRpcIncomingMessageFromJson,
	JsonRpcNotification,
	JsonRpcOutgoingMessageFromJson,
	type JsonRpcParams,
	JsonRpcRequest,
	JsonRpcSuccessResponse,
	type LspCapabilityName,
	LspDidCloseParams,
	LspDidOpenParams,
	LspDocument,
	type LspDocument as LspDocumentType,
	type LspFileInput,
	LspInitializeParams,
	LspInitializeResult,
	type LspPosition,
	type LspPositionInput,
	type LspRange,
	LspServerCapabilities,
	LspTextDocumentPositionParams,
	LspWorkspaceConfigurationParams,
} from './schema'

const SHUTDOWN_TIMEOUT_MS = 1_000
const MAX_STDOUT_BUFFER_BYTES = 1024 * 1024 * 16

function cancellation(tool: string, signal: AbortSignal) {
	return Effect.callback<never, LspToolError>((resume) => {
		const onAbort = () => {
			resume(Effect.fail(lspError(tool, 'LSP operation was cancelled.')))
		}
		if (signal.aborted) {
			onAbort()
			return
		}
		signal.addEventListener('abort', onAbort, { once: true })
		return Effect.sync(() => signal.removeEventListener('abort', onAbort))
	})
}

export function withCancellation<A, R>(
	tool: string,
	signal: AbortSignal,
	effect: Effect.Effect<A, LspToolError, R>,
) {
	if (signal.aborted) return Effect.fail(lspError(tool, 'LSP operation was cancelled.'))
	return Effect.raceFirst(effect, cancellation(tool, signal))
}

function hasCapability(
	capabilities: typeof LspServerCapabilities.Type,
	key: LspCapabilityName,
): boolean {
	const value = capabilities[key]
	return value === true || (typeof value === 'object' && value !== null)
}

export function hasPrepareRename(capabilities: typeof LspServerCapabilities.Type): boolean {
	const value = capabilities.renameProvider
	return typeof value === 'object' && value !== null && value.prepareProvider === true
}

function fileUri(filePath: string): string {
	return pathToFileURL(filePath).href
}

export function uriToFilePath(tool: string, server: string, uri: string) {
	if (!uri.startsWith('file:')) return Effect.void
	return Effect.try({
		try: () => fileURLToPath(uri),
		catch: (error) =>
			lspError(
				tool,
				`Server returned an invalid file URI ${uri}: ${describeUnknown(error)}`,
				server,
			),
	})
}

function lineOffsets(content: string): Array<number> {
	const offsets = [0]
	for (let index = 0; index < content.length; index += 1) {
		const char = content[index]
		if (char === '\r') {
			if (content[index + 1] === '\n') index += 1
			offsets.push(index + 1)
		} else if (char === '\n') {
			offsets.push(index + 1)
		}
	}
	return offsets
}

function lineText(content: string, line: number): string | undefined {
	return content.split(/\r\n|\r|\n/u)[line]
}

function positionAtOffset(content: string, offset: number): LspPosition {
	const offsets = lineOffsets(content)
	let line = 0
	for (let index = 0; index < offsets.length; index += 1) {
		const next = offsets[index + 1]
		if (next === undefined || next > offset) {
			line = index
			break
		}
	}
	return { line, character: offset - (offsets[line] ?? 0) }
}

function offsetAtPosition(content: string, position: LspPosition): number | undefined {
	const offsets = lineOffsets(content)
	const start = offsets[position.line]
	const text = lineText(content, position.line)
	if (start === undefined || text === undefined || position.character > text.length) {
		return undefined
	}
	return start + position.character
}

export const resolvePosition = Effect.fn(function* resolvePosition(
	tool: string,
	content: string,
	input: LspPositionInput,
) {
	if (input.offset !== undefined) {
		if (input.offset > content.length) {
			return yield* lspError(tool, `Offset ${input.offset} is outside the file.`)
		}
		return positionAtOffset(content, input.offset)
	}

	if (input.line === undefined || input.character === undefined) {
		return yield* lspError(tool, 'Provide either offset or both zero-based line and character.')
	}
	const position = LspTextDocumentPositionParams.fields.position.make({
		line: input.line,
		character: input.character,
	})
	if (offsetAtPosition(content, position) === undefined) {
		return yield* lspError(tool, `Position ${input.line}:${input.character} is outside the file.`)
	}
	return position
})

function textForRange(content: string, range: LspRange): string | undefined {
	const start = offsetAtPosition(content, range.start)
	const end = offsetAtPosition(content, range.end)
	if (start === undefined || end === undefined || end < start) return undefined
	return content.slice(start, end)
}

export function readRangeText(tool: string, server: string, filePath: string, range: LspRange) {
	return Effect.tryPromise({
		try: () => readFile(filePath, 'utf8'),
		catch: (error) =>
			lspError(
				tool,
				`Unable to read referenced file ${filePath}: ${describeUnknown(error)}`,
				server,
			),
	}).pipe(Effect.map((content) => textForRange(content, range)))
}

function requestErrorMessage(
	method: string,
	error: (typeof JsonRpcErrorResponse.Type)['error'],
): string {
	return `${method}: ${error.message}`
}

function removePending(connection: LspConnectionRuntime, id: number) {
	return Ref.update(connection.state, (state) => {
		if (!state.pending.has(id)) return state
		const pending = new Map(state.pending)
		pending.delete(id)
		return { ...state, pending }
	})
}

const closePending = Effect.fn(function* closePending(
	connection: LspConnectionRuntime,
	message: string,
) {
	const closed = yield* Ref.modify(connection.state, (state) => [
		{ pending: [...state.pending.values()], stderr: state.stderr },
		{ ...state, closed: true, pending: new Map() },
	])
	const stderr = closed.stderr.trim()
	const detail = stderr.length === 0 ? message : `${message}\n${stderr}`
	yield* Effect.forEach(closed.pending, (pending) =>
		Deferred.fail(
			pending.deferred,
			lspError(pending.tool, `${pending.method}: ${detail}`, connection.config.id),
		),
	)
})

function killProcess(connection: LspConnectionRuntime, signal: NodeJS.Signals = 'SIGTERM') {
	if (connection.process.exitCode !== null || connection.process.signalCode !== null) {
		return Effect.void
	}
	return Effect.try({
		try: () => {
			connection.process.kill(signal)
		},
		catch: (error) =>
			lspError(
				'lsp_process',
				`Unable to send ${signal} to LSP server: ${describeUnknown(error)}`,
				connection.config.id,
			),
	})
}

const abortConnection = Effect.fn(function* abortConnection(
	connection: LspConnectionRuntime,
	error: LspToolError,
) {
	yield* closePending(connection, error.message)
	yield* bestEffortFinalizer(killProcess(connection))
	if (!(yield* awaitProcessClose(connection, SHUTDOWN_TIMEOUT_MS))) {
		yield* bestEffortFinalizer(killProcess(connection, 'SIGKILL'))
		if (!(yield* awaitProcessClose(connection, SHUTDOWN_TIMEOUT_MS))) return
	}
	yield* Deferred.succeed(connection.eventsDrained, undefined)
})

function send(
	connection: LspConnectionRuntime,
	tool: string,
	message:
		| typeof JsonRpcRequest.Type
		| typeof JsonRpcNotification.Type
		| typeof JsonRpcSuccessResponse.Type
		| typeof JsonRpcErrorResponse.Type,
) {
	return Schema.encodeUnknownEffect(JsonRpcOutgoingMessageFromJson)(message).pipe(
		Effect.mapError((error) =>
			lspError(
				tool,
				`Unable to encode LSP message: ${schemaErrorMessage(error)}`,
				connection.config.id,
			),
		),
		Effect.flatMap((body) => {
			const frame = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
			return connection.writes.withPermit(
				Effect.callback<void, LspToolError>((resume) => {
					if (!connection.process.stdin.writable) {
						resume(Effect.fail(lspError(tool, 'LSP server stdin is closed.', connection.config.id)))
						return
					}
					try {
						connection.process.stdin.write(frame, (error) => {
							resume(
								error === undefined || error === null
									? Effect.void
									: Effect.fail(lspError(tool, describeUnknown(error), connection.config.id)),
							)
						})
					} catch (error) {
						resume(Effect.fail(lspError(tool, describeUnknown(error), connection.config.id)))
					}
				}),
			)
		}),
	)
}

export const request = Effect.fn(function* request(
	tool: string,
	connection: LspConnectionRuntime,
	method: string,
	params: JsonRpcParams | undefined,
	timeoutMs: number,
) {
	const deferred = yield* Deferred.make<unknown, LspToolError>()
	const id = yield* Ref.modify(connection.state, (state) => {
		if (state.closed || !Number.isSafeInteger(state.nextId)) return [undefined, state]
		const pending = new Map(state.pending)
		pending.set(state.nextId, { tool, method, deferred })
		return [state.nextId, { ...state, nextId: state.nextId + 1, pending }]
	})
	if (id === undefined) {
		return yield* lspError(tool, 'LSP connection is closed.', connection.config.id)
	}

	const message = JsonRpcRequest.make({
		jsonrpc: '2.0',
		id,
		method,
		...(params === undefined ? {} : { params }),
	})
	return yield* send(connection, tool, message).pipe(
		Effect.andThen(Deferred.await(deferred)),
		Effect.timeoutOrElse({
			duration: timeoutMs,
			orElse: () =>
				Effect.fail(
					lspError(tool, `${method} timed out after ${timeoutMs}ms.`, connection.config.id),
				),
		}),
		Effect.ensuring(removePending(connection, id)),
	)
})

function notify(
	tool: string,
	connection: LspConnectionRuntime,
	method: string,
	params: JsonRpcParams | undefined,
) {
	return Ref.get(connection.state).pipe(
		Effect.flatMap((state) =>
			state.closed
				? Effect.fail(lspError(tool, 'LSP connection is closed.', connection.config.id))
				: send(
						connection,
						tool,
						JsonRpcNotification.make({
							jsonrpc: '2.0',
							method,
							...(params === undefined ? {} : { params }),
						}),
					),
		),
	)
}

const completeResponse = Effect.fn(function* completeResponse(
	connection: LspConnectionRuntime,
	message: typeof JsonRpcSuccessResponse.Type | typeof JsonRpcErrorResponse.Type,
) {
	if (message.id === null) return
	const id = message.id
	const pending = yield* Ref.modify(connection.state, (state) => {
		const request = state.pending.get(id)
		if (request === undefined) return [undefined, state]
		const remaining = new Map(state.pending)
		remaining.delete(id)
		return [request, { ...state, pending: remaining }]
	})
	if (pending === undefined) return
	if ('error' in message) {
		yield* Deferred.fail(
			pending.deferred,
			lspError(
				pending.method,
				requestErrorMessage(pending.method, message.error),
				connection.config.id,
			),
		)
		return
	}
	yield* Deferred.succeed(pending.deferred, message.result)
})

function sendServerError(
	connection: LspConnectionRuntime,
	id: (typeof JsonRpcRequest.Type)['id'],
	code: number,
	message: string,
) {
	return send(
		connection,
		'lsp_client_response',
		JsonRpcErrorResponse.make({
			jsonrpc: '2.0',
			id,
			error: { code, message },
		}),
	)
}

const handleServerRequest = Effect.fn(function* handleServerRequest(
	connection: LspConnectionRuntime,
	message: typeof JsonRpcRequest.Type,
) {
	if (message.method === 'workspace/configuration') {
		const decoded = yield* Effect.result(
			decodeServerValue(
				'lsp_client_response',
				connection.config.id,
				'Invalid workspace/configuration parameters',
				LspWorkspaceConfigurationParams,
				message.params,
			),
		)
		if (Result.isFailure(decoded)) {
			yield* sendServerError(connection, message.id, -32602, decoded.failure.message)
			return
		}
		yield* send(
			connection,
			'lsp_client_response',
			JsonRpcSuccessResponse.make({
				jsonrpc: '2.0',
				id: message.id,
				result: decoded.success.items.map(() => null),
			}),
		)
		return
	}
	if (
		message.method === 'client/registerCapability' ||
		message.method === 'client/unregisterCapability' ||
		message.method === 'window/workDoneProgress/create'
	) {
		yield* send(
			connection,
			'lsp_client_response',
			JsonRpcSuccessResponse.make({ jsonrpc: '2.0', id: message.id, result: null }),
		)
		return
	}
	yield* sendServerError(
		connection,
		message.id,
		-32601,
		`Unsupported client request: ${message.method}`,
	)
})

const handleMessage = Effect.fn(function* handleMessage(
	connection: LspConnectionRuntime,
	body: string,
) {
	const message = yield* Schema.decodeUnknownEffect(JsonRpcIncomingMessageFromJson)(body).pipe(
		Effect.mapError((error) =>
			lspError(
				'lsp_transport',
				`Server sent malformed JSON-RPC: ${schemaErrorMessage(error)}`,
				connection.config.id,
			),
		),
	)
	if ('method' in message) {
		if ('id' in message) yield* handleServerRequest(connection, message)
		return
	}
	yield* completeResponse(connection, message)
})

const consumeConnectionEvents = Effect.fn(function* consumeConnectionEvents(
	connection: LspConnectionRuntime,
) {
	let stdout = Buffer.alloc(0)
	while (true) {
		const event = yield* Queue.take(connection.events)
		if (event._tag === 'stderr') {
			yield* Ref.update(connection.state, (state) => ({
				...state,
				stderr: `${state.stderr}${event.chunk.toString('utf8')}`.slice(-16_384),
			}))
			continue
		}
		if (event._tag === 'close') {
			const detail = `LSP server closed${event.code === null ? '' : ` with code ${event.code}`}${event.signal === null ? '' : ` (${event.signal})`}.`
			yield* closePending(connection, detail)
			yield* Deferred.succeed(connection.eventsDrained, undefined)
			return
		}
		if (event._tag === 'error') {
			return yield* lspError(
				'lsp_transport',
				`LSP ${event.source} error: ${describeUnknown(event.error)}`,
				connection.config.id,
			)
		}

		stdout = Buffer.concat([stdout, event.chunk])
		if (stdout.length > MAX_STDOUT_BUFFER_BYTES) {
			return yield* lspError(
				'lsp_transport',
				'LSP server emitted too much unframed stdout.',
				connection.config.id,
			)
		}
		while (true) {
			const headerEnd = stdout.indexOf('\r\n\r\n')
			if (headerEnd === -1) break
			const header = stdout.subarray(0, headerEnd).toString('ascii')
			const lengthMatch = /^Content-Length:\s*(\d+)$/imu.exec(header)
			const rawLength = lengthMatch?.[1]
			if (rawLength === undefined) {
				return yield* lspError(
					'lsp_transport',
					'LSP server sent a frame without a valid Content-Length header.',
					connection.config.id,
				)
			}
			const length = Number(rawLength)
			if (!Number.isSafeInteger(length) || length < 0 || length > MAX_STDOUT_BUFFER_BYTES) {
				return yield* lspError(
					'lsp_transport',
					`LSP server sent invalid Content-Length ${rawLength}.`,
					connection.config.id,
				)
			}
			const bodyStart = headerEnd + 4
			const bodyEnd = bodyStart + length
			if (stdout.length < bodyEnd) break
			const body = stdout.subarray(bodyStart, bodyEnd).toString('utf8')
			stdout = stdout.subarray(bodyEnd)
			yield* handleMessage(connection, body)
		}
	}
})

const acquireConnection = Effect.fn(function* acquireConnection(
	tool: string,
	config: LspServerConfigType,
	workspace: string,
) {
	const state = yield* Ref.make<LspRuntimeState>({
		closed: false,
		nextId: 1,
		pending: new Map(),
		stderr: '',
	})
	const capabilities = yield* Ref.make(LspServerCapabilities.make({}))
	const events = yield* Queue.unbounded<LspRuntimeEvent>()
	const processClosed = yield* Deferred.make<void>()
	const eventsDrained = yield* Deferred.make<void>()
	const writes = yield* Semaphore.make(1)
	const command = config.command[0]
	const args = config.command.slice(1)
	const child = yield* Effect.try({
		try: () =>
			spawn(command, args, {
				cwd: workspace,
				env: { ...process.env, ...config.env },
				stdio: 'pipe',
			}),
		catch: (error) =>
			lspError(tool, `Unable to start LSP server: ${describeUnknown(error)}`, config.id),
	})
	const onStdout = (chunk: Buffer) => {
		Queue.offerUnsafe(events, { _tag: 'stdout', chunk })
	}
	const onStderr = (chunk: Buffer) => {
		Queue.offerUnsafe(events, { _tag: 'stderr', chunk })
	}
	const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
		Queue.offerUnsafe(events, { _tag: 'close', code, signal })
		Deferred.doneUnsafe(processClosed, Effect.void)
	}
	const onProcessError = (error: Error) => {
		Queue.offerUnsafe(events, { _tag: 'error', source: 'process', error })
	}
	const onStdinError = (error: Error) => {
		Queue.offerUnsafe(events, { _tag: 'error', source: 'stdin', error })
	}
	const onStdoutError = (error: Error) => {
		Queue.offerUnsafe(events, { _tag: 'error', source: 'stdout', error })
	}
	const onStderrError = (error: Error) => {
		Queue.offerUnsafe(events, { _tag: 'error', source: 'stderr', error })
	}
	child.stdout.on('data', onStdout)
	child.stderr.on('data', onStderr)
	child.stdin.on('error', onStdinError)
	child.stdout.on('error', onStdoutError)
	child.stderr.on('error', onStderrError)
	child.on('close', onClose)
	child.on('error', onProcessError)
	const connection = {
		config,
		workspace,
		process: child,
		state,
		capabilities,
		events,
		processClosed,
		eventsDrained,
		writes,
		onStdout,
		onStderr,
		onClose,
		onProcessError,
		onStdinError,
		onStdoutError,
		onStderrError,
	} satisfies LspConnectionRuntime
	yield* consumeConnectionEvents(connection).pipe(
		Effect.catch((error) => abortConnection(connection, error)),
		Effect.forkChild({ startImmediately: true }),
	)
	return connection
})

function awaitProcessClose(connection: LspConnectionRuntime, timeoutMs: number) {
	return Deferred.await(connection.processClosed).pipe(
		Effect.as(true),
		Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(false) }),
	)
}

function awaitEventDrain(connection: LspConnectionRuntime, timeoutMs: number) {
	return Deferred.await(connection.eventsDrained).pipe(
		Effect.as(true),
		Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(false) }),
	)
}

function bestEffortFinalizer(effect: Effect.Effect<unknown, LspToolError>) {
	return effect.pipe(
		Effect.catch((error) =>
			Effect.logWarning(
				`[limitless] LSP finalizer failed for ${error.server ?? 'unknown server'}: ${error.message}`,
			),
		),
		Effect.asVoid,
	)
}

const releaseConnection = Effect.fn(function* releaseConnection(connection: LspConnectionRuntime) {
	const state = yield* Ref.get(connection.state)
	if (
		!state.closed &&
		connection.process.exitCode === null &&
		connection.process.signalCode === null
	) {
		yield* bestEffortFinalizer(
			request('lsp_shutdown', connection, 'shutdown', undefined, SHUTDOWN_TIMEOUT_MS),
		)
		yield* bestEffortFinalizer(notify('lsp_shutdown', connection, 'exit', undefined))
	}
	if (!(yield* awaitEventDrain(connection, SHUTDOWN_TIMEOUT_MS))) {
		yield* bestEffortFinalizer(killProcess(connection))
		if (!(yield* awaitEventDrain(connection, SHUTDOWN_TIMEOUT_MS))) {
			yield* bestEffortFinalizer(killProcess(connection, 'SIGKILL'))
			if (!(yield* awaitEventDrain(connection, SHUTDOWN_TIMEOUT_MS))) {
				yield* Effect.logError(
					`[limitless] LSP server ${connection.config.id} did not terminate after SIGKILL.`,
				)
			}
		}
	}
	yield* closePending(connection, 'LSP connection disposed.')
	connection.process.stdout.off('data', connection.onStdout)
	connection.process.stderr.off('data', connection.onStderr)
	connection.process.stdin.off('error', connection.onStdinError)
	connection.process.stdout.off('error', connection.onStdoutError)
	connection.process.stderr.off('error', connection.onStderrError)
	connection.process.off('close', connection.onClose)
	connection.process.off('error', connection.onProcessError)
})

const initializeConnection = Effect.fn(function* initializeConnection(
	tool: string,
	connection: LspConnectionRuntime,
	timeoutMs: number,
) {
	const params = LspInitializeParams.make({
		processId: process.pid,
		rootPath: connection.workspace,
		rootUri: fileUri(connection.workspace),
		workspaceFolders: [
			{ uri: fileUri(connection.workspace), name: path.basename(connection.workspace) },
		],
		capabilities: {
			general: { positionEncodings: ['utf-16'] },
			workspace: { workspaceFolders: true, symbol: {} },
			textDocument: {
				documentSymbol: { hierarchicalDocumentSymbolSupport: true },
				references: {},
				rename: { prepareSupport: true },
				synchronization: { didSave: true },
			},
		},
		...(connection.config.initialization === undefined
			? {}
			: { initializationOptions: connection.config.initialization }),
	})
	const raw = yield* request(tool, connection, 'initialize', params, timeoutMs)
	const initialized = yield* decodeServerValue(
		tool,
		connection.config.id,
		'Invalid initialize response',
		LspInitializeResult,
		raw,
	)
	yield* Ref.set(connection.capabilities, initialized.capabilities)
	yield* notify(tool, connection, 'initialized', {})
})

export function connectionResource(
	tool: string,
	config: LspServerConfigType,
	workspace: string,
	timeoutMs: number,
) {
	return Effect.gen(function* () {
		const connection = yield* Effect.acquireRelease(
			acquireConnection(tool, config, workspace),
			releaseConnection,
		)
		yield* initializeConnection(tool, connection, timeoutMs)
		return connection
	})
}

const openDocument = Effect.fn(function* openDocument(
	tool: string,
	connection: LspConnectionRuntime,
	filePath: string,
) {
	const content = yield* Effect.tryPromise({
		try: () => readFile(filePath, 'utf8'),
		catch: (error) =>
			lspError(
				tool,
				`Unable to read document ${filePath}: ${describeUnknown(error)}`,
				connection.config.id,
			),
	})
	const document = LspDocument.make({ uri: fileUri(filePath), content })
	yield* notify(
		tool,
		connection,
		'textDocument/didOpen',
		LspDidOpenParams.make({
			textDocument: {
				uri: document.uri,
				languageId: languageId(filePath, connection.config),
				version: 1,
				text: document.content,
			},
		}),
	)
	return document
})

function closeDocument(tool: string, connection: LspConnectionRuntime, document: LspDocumentType) {
	return notify(
		tool,
		connection,
		'textDocument/didClose',
		LspDidCloseParams.make({ textDocument: { uri: document.uri } }),
	)
}

function documentResource(tool: string, connection: LspConnectionRuntime, filePath: string) {
	return Effect.acquireRelease(openDocument(tool, connection, filePath), (document) =>
		bestEffortFinalizer(closeDocument(tool, connection, document)),
	)
}

export function withDocument<T>(
	tool: string,
	connection: LspConnectionRuntime,
	filePath: string,
	use: (document: LspDocumentType) => Effect.Effect<T, LspToolError>,
) {
	return Effect.scoped(
		Effect.gen(function* () {
			const document = yield* documentResource(tool, connection, filePath)
			return yield* use(document)
		}),
	)
}

export function runOnCapableServer<T>(
	tool: string,
	workspace: string,
	servers: ReadonlyArray<LspServerConfigType>,
	capability: LspCapabilityName,
	timeoutMs: number,
	use: (connection: LspConnectionRuntime) => Effect.Effect<T, LspToolError>,
) {
	return Effect.gen(function* () {
		const errors: Array<string> = []
		for (const config of servers) {
			const result = yield* Effect.result(
				Effect.scoped(
					Effect.gen(function* () {
						const connection = yield* connectionResource(tool, config, workspace, timeoutMs)
						const capabilities = yield* Ref.get(connection.capabilities)
						if (!hasCapability(capabilities, capability)) {
							return yield* lspError(
								tool,
								`Server ${config.id} does not support ${capability}.`,
								config.id,
							)
						}
						return yield* use(connection)
					}),
				),
			)
			if (Result.isSuccess(result)) return result.success
			errors.push(`${config.id}: ${result.failure.message}`)
		}
		return yield* lspError(
			tool,
			`No matching LSP server completed ${capability}. ${errors.join('; ') || 'No candidates.'}`,
		)
	})
}

export const resolveFile = Effect.fn(function* resolveFile(
	tool: string,
	workspace: string,
	input: LspFileInput,
) {
	const filePath = input.filePath ?? input.path
	if (filePath === undefined || filePath.length === 0) {
		return yield* lspError(tool, 'filePath or path is required.')
	}
	return workspacePath(workspace, filePath)
})

export const requireCandidates = Effect.fn(function* requireCandidates(
	tool: string,
	servers: ReadonlyArray<LspServerConfigType>,
	filePath: string | undefined,
	serverId: string | undefined,
) {
	const candidates = matchingServers(servers, filePath, serverId)
	if (candidates.length === 0) {
		const target = serverId ?? (filePath === undefined ? 'workspace' : pathExtension(filePath))
		return yield* lspError(tool, `No configured LSP server matches ${target}.`)
	}
	return candidates
})

export function maybeLimit<T>(items: ReadonlyArray<T>, maxResults: number | undefined) {
	if (maxResults === undefined) return { items, truncated: false }
	return { items: items.slice(0, maxResults), truncated: items.length > maxResults }
}
