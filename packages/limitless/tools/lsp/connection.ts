import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Deferred, Effect, MutableRef, Ref, Result, Schema } from 'effect'
import {
	type CancellationToken,
	CancellationTokenSource,
	ConfigurationRequest,
	createProtocolConnection,
	DidCloseTextDocumentNotification,
	DidOpenTextDocumentNotification,
	type Disposable,
	ErrorCodes,
	ExitNotification,
	InitializedNotification,
	type InitializeParams,
	InitializeRequest,
	MarkupKind,
	PositionEncodingKind,
	type ProtocolConnection,
	type ProtocolNotificationType,
	type ProtocolNotificationType0,
	type ProtocolRequestType,
	type ProtocolRequestType0,
	RegistrationRequest,
	type RequestParam,
	ResponseError,
	ShutdownRequest,
	UnregistrationRequest,
	WorkDoneProgressCreateRequest,
	WorkspaceFoldersRequest,
} from 'vscode-languageserver-protocol/node'
import { workspacePath } from '../../core/paths'
import { describeUnknown, schemaErrorMessage } from '../../lib/guards'
import {
	type LspServerConfig as LspServerConfigType,
	languageId,
	matchingServers,
	pathExtension,
} from './config'
import { decodeServerValue, type LspToolError, lspError } from './errors'
import type { LspConnectionRuntime, LspRuntimeState } from './runtime'
import {
	type LspCapabilityName,
	LspDocument,
	type LspDocument as LspDocumentType,
	type LspFileInput,
	LspInitializeResult,
	type LspPosition,
	type LspPositionInput,
	type LspRange,
	LspServerCapabilities,
	LspWorkspaceConfigurationParams,
} from './schema'

const SHUTDOWN_TIMEOUT_MS = 1_000

export function withOperationDeadline<A, R>(
	tool: string,
	connection: LspConnectionRuntime,
	operation: string,
	timeoutMs: number,
	effect: Effect.Effect<A, LspToolError, R>,
) {
	return effect.pipe(
		Effect.timeoutOrElse({
			duration: timeoutMs,
			orElse: () =>
				Effect.fail(
					lspError(tool, `${operation} timed out after ${timeoutMs}ms.`, connection.config.id),
				),
		}),
	)
}

export function supportsCapability(
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

function workspaceFolder(workspace: string) {
	return { uri: fileUri(workspace), name: path.basename(workspace) }
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
	const position = { line: input.line, character: input.character }
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
		try: (signal) => readFile(filePath, { encoding: 'utf8', signal }),
		catch: (error) =>
			lspError(
				tool,
				`Unable to read referenced file ${filePath}: ${describeUnknown(error)}`,
				server,
			),
	}).pipe(Effect.map((content) => textForRange(content, range)))
}

function updateRuntimeState(
	state: Ref.Ref<LspRuntimeState>,
	update: (current: LspRuntimeState) => LspRuntimeState,
): void {
	MutableRef.update(state.ref, update)
}

function connectionDetail(connection: LspConnectionRuntime, fallback: string): string {
	const state = Ref.getUnsafe(connection.state)
	const message = state.failure ?? fallback
	const stderr = state.stderr.trim()
	return stderr.length === 0 ? message : `${message}\n${stderr}`
}

function signalTransportFailure(
	state: Ref.Ref<LspRuntimeState>,
	transportFailed: Deferred.Deferred<void>,
	message: string,
): void {
	updateRuntimeState(state, (current) => ({
		...current,
		closed: true,
		failure: current.failure ?? message,
	}))
	Deferred.doneUnsafe(transportFailed, Effect.void)
}

function transportFailure(
	tool: string,
	connection: LspConnectionRuntime,
	method: string | undefined,
): Effect.Effect<never, LspToolError> {
	return Deferred.await(connection.transportFailed).pipe(
		Effect.flatMap(() => {
			const detail = connectionDetail(connection, 'LSP connection closed.')
			return Effect.fail(
				lspError(
					tool,
					method === undefined ? detail : `${method}: ${detail}`,
					connection.config.id,
				),
			)
		}),
	)
}

function requestFailure(
	tool: string,
	connection: LspConnectionRuntime,
	method: string,
	error: unknown,
): LspToolError {
	const state = Ref.getUnsafe(connection.state)
	const detail =
		state.failure === undefined
			? describeUnknown(error)
			: connectionDetail(connection, describeUnknown(error))
	return lspError(tool, `${method}: ${detail}`, connection.config.id)
}

function awaitProtocolRequest<R>(
	tool: string,
	connection: LspConnectionRuntime,
	method: string,
	timeoutMs: number,
	dispatch: (token: CancellationToken) => Promise<R>,
): Effect.Effect<R, LspToolError> {
	const sendRequest = Effect.suspend(() => {
		const state = Ref.getUnsafe(connection.state)
		if (state.closed) {
			return Effect.fail(
				lspError(
					tool,
					`${method}: ${connectionDetail(connection, 'LSP connection is closed.')}`,
					connection.config.id,
				),
			)
		}

		const cancellationSource = new CancellationTokenSource()
		let settled = false
		return Effect.tryPromise({
			try: () =>
				dispatch(cancellationSource.token).then(
					(value) => {
						settled = true
						return value
					},
					(error: unknown) => {
						settled = true
						throw error
					},
				),
			catch: (error) => requestFailure(tool, connection, method, error),
		}).pipe(
			Effect.onInterrupt(() =>
				Effect.sync(() => {
					if (!settled && !Ref.getUnsafe(connection.state).closed) cancellationSource.cancel()
				}),
			),
			Effect.ensuring(Effect.sync(() => cancellationSource.dispose())),
		)
	})

	return Effect.raceFirst(sendRequest, transportFailure(tool, connection, method)).pipe(
		Effect.timeoutOrElse({
			duration: timeoutMs,
			orElse: () =>
				Effect.fail(
					lspError(tool, `${method} timed out after ${timeoutMs}ms.`, connection.config.id),
				),
		}),
	)
}

export function request<P, R, PR, E, RO>(
	tool: string,
	connection: LspConnectionRuntime,
	requestType: ProtocolRequestType<P, R, PR, E, RO>,
	params: RequestParam<P>,
	timeoutMs: number,
): Effect.Effect<R, LspToolError> {
	return awaitProtocolRequest(tool, connection, requestType.method, timeoutMs, (token) =>
		connection.protocol.sendRequest(requestType, params, token),
	)
}

function requestWithoutParams<R, PR, E, RO>(
	tool: string,
	connection: LspConnectionRuntime,
	requestType: ProtocolRequestType0<R, PR, E, RO>,
	timeoutMs: number,
): Effect.Effect<R, LspToolError> {
	return awaitProtocolRequest(tool, connection, requestType.method, timeoutMs, (token) =>
		connection.protocol.sendRequest(requestType, token),
	)
}

function awaitProtocolNotification(
	tool: string,
	connection: LspConnectionRuntime,
	method: string,
	timeoutMs: number,
	dispatch: () => Promise<void>,
): Effect.Effect<void, LspToolError> {
	const sendNotification = Effect.suspend(() => {
		const state = Ref.getUnsafe(connection.state)
		if (state.closed) {
			return Effect.fail(
				lspError(
					tool,
					`${method}: ${connectionDetail(connection, 'LSP connection is closed.')}`,
					connection.config.id,
				),
			)
		}
		return Effect.tryPromise({
			try: dispatch,
			catch: (error) => requestFailure(tool, connection, method, error),
		})
	})

	return Effect.raceFirst(sendNotification, transportFailure(tool, connection, method)).pipe(
		Effect.timeoutOrElse({
			duration: timeoutMs,
			orElse: () =>
				Effect.fail(
					lspError(tool, `${method} timed out after ${timeoutMs}ms.`, connection.config.id),
				),
		}),
	)
}

function notify<P, RO>(
	tool: string,
	connection: LspConnectionRuntime,
	notificationType: ProtocolNotificationType<P, RO>,
	params: RequestParam<P>,
	timeoutMs: number,
) {
	return awaitProtocolNotification(tool, connection, notificationType.method, timeoutMs, () =>
		connection.protocol.sendNotification(notificationType, params),
	)
}

function notifyWithoutParams<RO>(
	tool: string,
	connection: LspConnectionRuntime,
	notificationType: ProtocolNotificationType0<RO>,
	timeoutMs: number,
) {
	return awaitProtocolNotification(tool, connection, notificationType.method, timeoutMs, () =>
		connection.protocol.sendNotification(notificationType),
	)
}

function installProtocolHandlers(
	protocol: ProtocolConnection,
	workspace: string,
	failTransport: (message: string) => void,
): ReadonlyArray<Disposable> {
	return [
		protocol.onRequest(ConfigurationRequest.type, (params) => {
			const decoded = Schema.decodeUnknownResult(LspWorkspaceConfigurationParams)(params)
			if (Result.isFailure(decoded)) {
				return new ResponseError<void>(
					ErrorCodes.InvalidParams,
					`Invalid workspace/configuration parameters: ${schemaErrorMessage(decoded.failure)}`,
				)
			}
			return decoded.success.items.map(() => null)
		}),
		protocol.onRequest(RegistrationRequest.type, () => undefined),
		protocol.onRequest(UnregistrationRequest.type, () => undefined),
		protocol.onRequest(WorkDoneProgressCreateRequest.type, () => undefined),
		protocol.onRequest(WorkspaceFoldersRequest.type, () => [workspaceFolder(workspace)]),
		protocol.onUnhandledNotification(() => undefined),
		protocol.onError(([error]) => failTransport(`LSP transport error: ${describeUnknown(error)}`)),
		protocol.onClose(() => failTransport('LSP connection closed.')),
	]
}

function disposeDisposables(disposables: ReadonlyArray<Disposable>): Array<string> {
	const errors: Array<string> = []
	for (const disposable of disposables) {
		try {
			disposable.dispose()
		} catch (error) {
			errors.push(describeUnknown(error))
		}
	}
	return errors
}

function cleanupProtocolSetup(
	protocol: ProtocolConnection,
	disposables: ReadonlyArray<Disposable>,
): Array<string> {
	const errors = disposeDisposables(disposables)
	try {
		protocol.dispose()
	} catch (error) {
		errors.push(describeUnknown(error))
	}
	return errors
}

const acquireConnection = Effect.fn(function* acquireConnection(
	tool: string,
	config: LspServerConfigType,
	workspace: string,
	child: ChildProcessWithoutNullStreams,
) {
	const state = yield* Ref.make<LspRuntimeState>({
		closed: false,
		stderr: '',
		failure: undefined,
	})
	const capabilities = yield* Ref.make(LspServerCapabilities.make({}))
	const transportFailed = yield* Deferred.make<void>()
	const processClosed = yield* Deferred.make<void>()
	const failTransport = (message: string) => signalTransportFailure(state, transportFailed, message)
	const onStderr = (chunk: Buffer) => {
		updateRuntimeState(state, (current) => ({
			...current,
			stderr: `${current.stderr}${chunk.toString('utf8')}`.slice(-16_384),
		}))
	}
	const onProcessClose = (code: number | null, signal: NodeJS.Signals | null) => {
		const detail = `LSP server closed${code === null ? '' : ` with code ${code}`}${signal === null ? '' : ` (${signal})`}.`
		updateRuntimeState(state, (current) => ({
			...current,
			closed: true,
			failure:
				current.failure === undefined || current.failure === 'LSP connection closed.'
					? detail
					: current.failure,
		}))
		Deferred.doneUnsafe(processClosed, Effect.void)
		Deferred.doneUnsafe(transportFailed, Effect.void)
	}
	const onProcessError = (error: Error) =>
		failTransport(`LSP process error: ${describeUnknown(error)}`)
	const onStderrError = (error: Error) =>
		failTransport(`LSP stderr error: ${describeUnknown(error)}`)
	child.stderr.on('data', onStderr)
	child.on('close', onProcessClose)
	child.on('error', onProcessError)
	child.stderr.on('error', onStderrError)

	const protocolResult = yield* Effect.result(
		Effect.try({
			try: () => createProtocolConnection(child.stdout, child.stdin),
			catch: (error) =>
				lspError(tool, `Unable to create LSP connection: ${describeUnknown(error)}`, config.id),
		}),
	)
	if (Result.isFailure(protocolResult)) {
		child.stderr.off('data', onStderr)
		child.off('close', onProcessClose)
		child.off('error', onProcessError)
		child.stderr.off('error', onStderrError)
		return yield* protocolResult.failure
	}
	const protocol = protocolResult.success
	const protocolDisposables: Array<Disposable> = []
	const listenResult = yield* Effect.result(
		Effect.try({
			try: () => {
				protocolDisposables.push(...installProtocolHandlers(protocol, workspace, failTransport))
				protocol.listen()
			},
			catch: (error) =>
				lspError(tool, `Unable to listen to LSP connection: ${describeUnknown(error)}`, config.id),
		}),
	)
	if (Result.isFailure(listenResult)) {
		const cleanupErrors = cleanupProtocolSetup(protocol, protocolDisposables)
		child.stderr.off('data', onStderr)
		child.off('close', onProcessClose)
		child.off('error', onProcessError)
		child.stderr.off('error', onStderrError)
		const suffix = cleanupErrors.length === 0 ? '' : ` Cleanup failed: ${cleanupErrors.join('; ')}`
		return yield* lspError(tool, `${listenResult.failure.message}${suffix}`, config.id)
	}

	return {
		config,
		workspace,
		process: child,
		protocol,
		state,
		capabilities,
		transportFailed,
		processClosed,
		protocolDisposables,
		onStderr,
		onProcessClose,
		onProcessError,
		onStderrError,
	} satisfies LspConnectionRuntime
})

function processIsRunning(child: ChildProcessWithoutNullStreams): boolean {
	return child.exitCode === null && child.signalCode === null
}

function processHasClosed(child: ChildProcessWithoutNullStreams): boolean {
	return (
		!processIsRunning(child) && child.stdin.closed && child.stdout.closed && child.stderr.closed
	)
}

function killChild(
	child: ChildProcessWithoutNullStreams,
	server: string,
	signal: NodeJS.Signals = 'SIGTERM',
) {
	if (!processIsRunning(child)) return Effect.void
	return Effect.try({
		try: () => {
			child.kill(signal)
		},
		catch: (error) =>
			lspError(
				'lsp_process',
				`Unable to send ${signal} to LSP server: ${describeUnknown(error)}`,
				server,
			),
	})
}

function awaitChildClose(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
	if (processHasClosed(child)) return Effect.succeed(true)
	return Effect.callback<void>((resume) => {
		const onClose = () => resume(Effect.void)
		child.once('close', onClose)
		if (processHasClosed(child)) onClose()
		return Effect.sync(() => child.off('close', onClose))
	}).pipe(
		Effect.as(true),
		Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(false) }),
	)
}

function awaitProcessClose(connection: LspConnectionRuntime, timeoutMs: number) {
	if (processHasClosed(connection.process)) return Effect.succeed(true)
	return Deferred.await(connection.processClosed).pipe(
		Effect.as(true),
		Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(false) }),
	)
}

function destroyChildStreams(child: ChildProcessWithoutNullStreams, server: string) {
	return Effect.try({
		try: () => {
			const errors: Array<string> = []
			for (const stream of [child.stdin, child.stdout, child.stderr]) {
				try {
					stream.destroy()
				} catch (error) {
					errors.push(describeUnknown(error))
				}
			}
			if (errors.length > 0) throw new Error(errors.join('; '))
		},
		catch: (error) =>
			lspError(
				'lsp_process',
				`Unable to close LSP server streams: ${describeUnknown(error)}`,
				server,
			),
	})
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

const ensureProcessStopped = Effect.fn(function* ensureProcessStopped(
	config: LspServerConfigType,
	child: ChildProcessWithoutNullStreams,
) {
	if (processHasClosed(child)) return
	yield* bestEffortFinalizer(
		processIsRunning(child) ? killChild(child, config.id) : destroyChildStreams(child, config.id),
	)
	if (yield* awaitChildClose(child, SHUTDOWN_TIMEOUT_MS)) return
	yield* bestEffortFinalizer(
		processIsRunning(child)
			? killChild(child, config.id, 'SIGKILL')
			: destroyChildStreams(child, config.id),
	)
	if (!(yield* awaitChildClose(child, SHUTDOWN_TIMEOUT_MS))) {
		yield* Effect.logError(`[limitless] LSP server ${config.id} did not terminate after SIGKILL.`)
	}
})

function closeProtocol(connection: LspConnectionRuntime) {
	return Effect.try({
		try: () => {
			const errors: Array<string> = []
			try {
				connection.protocol.end()
			} catch (error) {
				errors.push(`end: ${describeUnknown(error)}`)
			}
			try {
				connection.protocol.dispose()
			} catch (error) {
				errors.push(`dispose: ${describeUnknown(error)}`)
			}
			errors.push(...disposeDisposables(connection.protocolDisposables))
			if (errors.length > 0) throw new Error(errors.join('; '))
		},
		catch: (error) =>
			lspError(
				'lsp_shutdown',
				`Unable to close LSP protocol connection: ${describeUnknown(error)}`,
				connection.config.id,
			),
	})
}

const releaseConnection = Effect.fn(function* releaseConnection(connection: LspConnectionRuntime) {
	const state = yield* Ref.get(connection.state)
	if (!state.closed && processIsRunning(connection.process)) {
		yield* bestEffortFinalizer(
			requestWithoutParams('lsp_shutdown', connection, ShutdownRequest.type, SHUTDOWN_TIMEOUT_MS),
		)
		yield* bestEffortFinalizer(
			notifyWithoutParams('lsp_shutdown', connection, ExitNotification.type, SHUTDOWN_TIMEOUT_MS),
		)
	}
	yield* Ref.update(connection.state, (current) => ({ ...current, closed: true }))
	yield* bestEffortFinalizer(closeProtocol(connection))
	if (!(yield* awaitProcessClose(connection, SHUTDOWN_TIMEOUT_MS))) {
		yield* bestEffortFinalizer(
			processIsRunning(connection.process)
				? killChild(connection.process, connection.config.id)
				: destroyChildStreams(connection.process, connection.config.id),
		)
		if (!(yield* awaitProcessClose(connection, SHUTDOWN_TIMEOUT_MS))) {
			yield* bestEffortFinalizer(
				processIsRunning(connection.process)
					? killChild(connection.process, connection.config.id, 'SIGKILL')
					: destroyChildStreams(connection.process, connection.config.id),
			)
			if (!(yield* awaitProcessClose(connection, SHUTDOWN_TIMEOUT_MS))) {
				yield* Effect.logError(
					`[limitless] LSP server ${connection.config.id} did not terminate after SIGKILL.`,
				)
			}
		}
	}
	connection.process.stderr.off('data', connection.onStderr)
	connection.process.off('close', connection.onProcessClose)
	connection.process.off('error', connection.onProcessError)
	connection.process.stderr.off('error', connection.onStderrError)
})

const spawnServer = Effect.fn(function* spawnServer(
	tool: string,
	config: LspServerConfigType,
	workspace: string,
) {
	const command = config.command[0]
	const args = config.command.slice(1)
	return yield* Effect.try({
		try: () =>
			spawn(command, args, {
				cwd: workspace,
				env: { ...process.env, ...config.env },
				stdio: 'pipe',
			}),
		catch: (error) =>
			lspError(tool, `Unable to start LSP server: ${describeUnknown(error)}`, config.id),
	})
})

const initializeConnection = Effect.fn(function* initializeConnection(
	tool: string,
	connection: LspConnectionRuntime,
	timeoutMs: number,
) {
	const params: InitializeParams = {
		processId: process.pid,
		rootPath: connection.workspace,
		rootUri: fileUri(connection.workspace),
		workspaceFolders: [workspaceFolder(connection.workspace)],
		capabilities: {
			general: { positionEncodings: [PositionEncodingKind.UTF16] },
			workspace: { workspaceFolders: true, symbol: {} },
			textDocument: {
				callHierarchy: {},
				declaration: { linkSupport: true },
				definition: { linkSupport: true },
				documentSymbol: { hierarchicalDocumentSymbolSupport: true },
				hover: { contentFormat: [MarkupKind.Markdown, MarkupKind.PlainText] },
				implementation: { linkSupport: true },
				references: {},
				rename: { prepareSupport: true },
				synchronization: { didSave: true },
				typeDefinition: { linkSupport: true },
			},
		},
		...(connection.config.initialization === undefined
			? {}
			: { initializationOptions: connection.config.initialization }),
	}
	const raw = yield* request(tool, connection, InitializeRequest.type, params, timeoutMs)
	const initialized = yield* decodeServerValue(
		tool,
		connection.config.id,
		'Invalid initialize response',
		LspInitializeResult,
		raw,
	)
	yield* Ref.set(connection.capabilities, initialized.capabilities)
	yield* notify(tool, connection, InitializedNotification.type, {}, timeoutMs)
})

export function connectionResource(
	tool: string,
	config: LspServerConfigType,
	workspace: string,
	timeoutMs: number,
) {
	return Effect.gen(function* () {
		const child = yield* Effect.acquireRelease(spawnServer(tool, config, workspace), (process) =>
			ensureProcessStopped(config, process),
		)
		const connection = yield* Effect.acquireRelease(
			acquireConnection(tool, config, workspace, child),
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
	timeoutMs: number,
) {
	const content = yield* Effect.tryPromise({
		try: (signal) => readFile(filePath, { encoding: 'utf8', signal }),
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
		DidOpenTextDocumentNotification.type,
		{
			textDocument: {
				uri: document.uri,
				languageId: languageId(filePath, connection.config),
				version: 1,
				text: document.content,
			},
		},
		timeoutMs,
	)
	return document
})

function closeDocument(tool: string, connection: LspConnectionRuntime, document: LspDocumentType) {
	return notify(
		tool,
		connection,
		DidCloseTextDocumentNotification.type,
		{
			textDocument: { uri: document.uri },
		},
		SHUTDOWN_TIMEOUT_MS,
	)
}

function documentResource(
	tool: string,
	connection: LspConnectionRuntime,
	filePath: string,
	timeoutMs: number,
) {
	return Effect.acquireRelease(openDocument(tool, connection, filePath, timeoutMs), (document) =>
		bestEffortFinalizer(closeDocument(tool, connection, document)),
	)
}

export function withDocument<T>(
	tool: string,
	connection: LspConnectionRuntime,
	filePath: string,
	timeoutMs: number,
	use: (document: LspDocumentType) => Effect.Effect<T, LspToolError>,
) {
	return Effect.scoped(
		Effect.gen(function* () {
			const document = yield* documentResource(tool, connection, filePath, timeoutMs)
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
						if (!supportsCapability(capabilities, capability)) {
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
			servers.length === 1 ? servers[0]?.id : undefined,
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
