import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { PluginInput, ToolContext } from '@opencode-ai/plugin'
import { Effect, Schema } from 'effect'
import {
	DEFAULT_TIMEOUT_MS,
	describeUnknown,
	LspToolError,
	objectProperty,
	workspacePath,
	workspaceRelative,
	workspaceRoot,
} from './shared'

type JsonRpcId = number | string

type JsonRpcMessage = {
	readonly id?: unknown
	readonly method?: unknown
	readonly params?: unknown
	readonly result?: unknown
	readonly error?: unknown
}

type PendingRequest = {
	readonly method: string
	readonly resolve: (value: unknown) => void
	readonly reject: (error: Error) => void
	readonly timeout: ReturnType<typeof setTimeout>
}

type LspServerConfig = {
	readonly id: string
	readonly command: ReadonlyArray<string>
	readonly extensions: ReadonlyArray<string>
	readonly env: Readonly<Record<string, string>>
	readonly initialization: unknown
	readonly languageIds: Readonly<Record<string, string>>
}

type LspDocument = {
	readonly uri: string
	readonly content: string
}

type LspPosition = {
	readonly line: number
	readonly character: number
}

type LspRange = {
	readonly start: LspPosition
	readonly end: LspPosition
}

type LspLocation = {
	readonly uri: string
	readonly range: LspRange
}

type LspLocationLink = {
	readonly targetUri: string
	readonly targetRange: LspRange
	readonly targetSelectionRange?: LspRange
}

type NormalizedLocation = {
	readonly uri: string
	readonly filePath: string
	readonly range: LspRange
	readonly text?: string
}

type NormalizedSymbol = {
	readonly name: string
	readonly kind?: number
	readonly detail?: string
	readonly filePath?: string
	readonly range?: LspRange
	readonly selectionRange?: LspRange
	readonly children?: ReadonlyArray<NormalizedSymbol>
}

type NormalizedEdit = {
	readonly filePath: string
	readonly range: LspRange
	readonly newText: string
}

type WorkspaceEditPreview = {
	readonly edits: ReadonlyArray<NormalizedEdit>
	readonly unsupportedChanges: ReadonlyArray<unknown>
}

export const LspReferencesInput = Schema.Struct({
	workspace: Schema.optional(Schema.String),
	filePath: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
	server: Schema.optional(Schema.String),
	timeoutMs: Schema.optional(Schema.Finite),
	maxResults: Schema.optional(Schema.Finite),
	offset: Schema.optional(Schema.Finite),
	line: Schema.optional(Schema.Finite),
	character: Schema.optional(Schema.Finite),
	includeDeclaration: Schema.optional(Schema.Boolean),
})

export type LspReferencesInput = typeof LspReferencesInput.Type

export const LspSymbolsInput = Schema.Struct({
	workspace: Schema.optional(Schema.String),
	filePath: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
	server: Schema.optional(Schema.String),
	timeoutMs: Schema.optional(Schema.Finite),
	query: Schema.optional(Schema.String),
	maxResults: Schema.optional(Schema.Finite),
})

export type LspSymbolsInput = typeof LspSymbolsInput.Type

export const LspRenameInput = Schema.Struct({
	workspace: Schema.optional(Schema.String),
	filePath: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
	server: Schema.optional(Schema.String),
	timeoutMs: Schema.optional(Schema.Finite),
	offset: Schema.optional(Schema.Finite),
	line: Schema.optional(Schema.Finite),
	character: Schema.optional(Schema.Finite),
	newName: Schema.String,
})

export type LspRenameInput = typeof LspRenameInput.Type

const builtInLanguageIds: Record<string, string> = {
	'.cjs': 'javascript',
	'.cts': 'typescript',
	'.js': 'javascript',
	'.c': 'c',
	'.cc': 'cpp',
	'.cpp': 'cpp',
	'.cs': 'csharp',
	'.json': 'json',
	'.jsonc': 'json',
	'.go': 'go',
	'.h': 'c',
	'.hpp': 'cpp',
	'.java': 'java',
	'.jsx': 'javascriptreact',
	'.kt': 'kotlin',
	'.kts': 'kotlin',
	'.lua': 'lua',
	'.markdown': 'markdown',
	'.md': 'markdown',
	'.mjs': 'javascript',
	'.mts': 'typescript',
	'.nix': 'nix',
	'.php': 'php',
	'.py': 'python',
	'.rb': 'ruby',
	'.rs': 'rust',
	'.sh': 'shellscript',
	'.swift': 'swift',
	'.toml': 'toml',
	'.ts': 'typescript',
	'.tsx': 'typescriptreact',
	'.yaml': 'yaml',
	'.yml': 'yaml',
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
	return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function stringRecord(value: unknown): Record<string, string> {
	if (!isObject(value)) return {}
	const result: Record<string, string> = {}
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === 'string') result[normalizeExtension(key)] = item
	}
	return result
}

function normalizeExtension(extension: string): string {
	return extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`
}

function normalizeCommand(raw: Record<string, unknown>): ReadonlyArray<string> | undefined {
	const command = objectProperty(raw, 'command')
	if (isStringArray(command) && command.length > 0) return command
	if (typeof command !== 'string' || command.length === 0) return undefined
	const args = objectProperty(raw, 'args')
	return isStringArray(args) ? [command, ...args] : [command]
}

function normalizeLspConfig(config: unknown): ReadonlyArray<LspServerConfig> {
	if (!isObject(config)) return []
	const lsp = objectProperty(config, 'lsp')
	if (!isObject(lsp)) return []

	const servers: Array<LspServerConfig> = []
	for (const [id, raw] of Object.entries(lsp)) {
		if (!isObject(raw)) continue
		if (objectProperty(raw, 'disabled') === true) continue
		const command = normalizeCommand(raw)
		if (command === undefined) continue
		const extensions = objectProperty(raw, 'extensions')
		servers.push({
			id,
			command,
			extensions: isStringArray(extensions) ? extensions.map(normalizeExtension) : [],
			env: stringRecord(objectProperty(raw, 'env')),
			initialization: objectProperty(raw, 'initialization'),
			languageIds: stringRecord(objectProperty(raw, 'languageIds')),
		})
	}
	return servers
}

function lspError(tool: string, message: string, server?: string) {
	const payload = server === undefined ? { tool, message } : { tool, message, server }
	return new LspToolError(payload)
}

async function getOpenCodeConfig(input: PluginInput, workspace: string): Promise<unknown> {
	const result = await input.client.config.get({ query: { directory: workspace } })
	return result.data
}

function loadServerConfigs(
	input: PluginInput,
	tool: string,
	workspace: string,
): Effect.Effect<ReadonlyArray<LspServerConfig>, LspToolError> {
	return Effect.tryPromise({
		try: () => getOpenCodeConfig(input, workspace),
		catch: (error) => lspError(tool, `Unable to read OpenCode config: ${describeUnknown(error)}`),
	}).pipe(
		Effect.map(normalizeLspConfig),
		Effect.flatMap((configs) =>
			configs.length === 0
				? Effect.fail(lspError(tool, 'No LSP servers are configured in OpenCode config.'))
				: Effect.succeed(configs),
		),
	)
}

function pathExtension(filePath: string): string {
	if (path.basename(filePath).toLowerCase() === 'flake.lock') return '.json'
	return path.extname(filePath).toLowerCase()
}

function matchingServers(
	servers: ReadonlyArray<LspServerConfig>,
	filePath: string | undefined,
	serverId: string | undefined,
): ReadonlyArray<LspServerConfig> {
	if (serverId !== undefined) return servers.filter((server) => server.id === serverId)
	if (filePath === undefined) return []
	const extension = pathExtension(filePath)
	return servers.filter((server) => server.extensions.includes(extension))
}

function hasCapability(capabilities: unknown, key: string): boolean {
	if (!isObject(capabilities)) return false
	const value = objectProperty(capabilities, key)
	return value === true || isObject(value)
}

function hasPrepareRename(capabilities: unknown): boolean {
	if (!isObject(capabilities)) return false
	const value = objectProperty(capabilities, 'renameProvider')
	return isObject(value) && objectProperty(value, 'prepareProvider') === true
}

function languageId(filePath: string, config: LspServerConfig): string {
	const extension = pathExtension(filePath)
	return (
		(config.languageIds[extension] ?? builtInLanguageIds[extension] ?? extension.slice(1)) ||
		config.id
	)
}

function fileUri(filePath: string): string {
	return pathToFileURL(filePath).href
}

function uriToFilePath(uri: string): string | undefined {
	try {
		return fileURLToPath(uri)
	} catch {
		return undefined
	}
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
	if (position.line < 0 || position.character < 0) return undefined
	const offsets = lineOffsets(content)
	const start = offsets[position.line]
	const text = lineText(content, position.line)
	if (start === undefined || text === undefined || position.character > text.length)
		return undefined
	return start + position.character
}

function integer(value: number | undefined): number | undefined {
	if (value === undefined) return undefined
	return Number.isInteger(value) ? value : undefined
}

function resolvePosition(
	tool: string,
	content: string,
	input: {
		readonly offset?: number | undefined
		readonly line?: number | undefined
		readonly character?: number | undefined
	},
): LspPosition {
	const offset = integer(input.offset)
	if (offset !== undefined) {
		if (offset < 0 || offset > content.length) {
			throw lspError(tool, `Offset ${offset} is outside the file.`)
		}
		return positionAtOffset(content, offset)
	}

	const line = integer(input.line)
	const character = integer(input.character)
	if (line === undefined || character === undefined) {
		throw lspError(tool, 'Provide either offset or both zero-based line and character.')
	}
	const position = { line, character }
	if (offsetAtPosition(content, position) === undefined) {
		throw lspError(tool, `Position ${line}:${character} is outside the file.`)
	}
	return position
}

function textForRange(content: string, range: LspRange): string | undefined {
	const start = offsetAtPosition(content, range.start)
	const end = offsetAtPosition(content, range.end)
	if (start === undefined || end === undefined || end < start) return undefined
	return content.slice(start, end)
}

function normalizeRange(value: unknown): LspRange | undefined {
	if (!isObject(value)) return undefined
	const start = objectProperty(value, 'start')
	const end = objectProperty(value, 'end')
	if (!isObject(start) || !isObject(end)) return undefined
	const startLine = objectProperty(start, 'line')
	const startCharacter = objectProperty(start, 'character')
	const endLine = objectProperty(end, 'line')
	const endCharacter = objectProperty(end, 'character')
	if (
		typeof startLine !== 'number' ||
		typeof startCharacter !== 'number' ||
		typeof endLine !== 'number' ||
		typeof endCharacter !== 'number'
	) {
		return undefined
	}
	return {
		start: { line: startLine, character: startCharacter },
		end: { line: endLine, character: endCharacter },
	}
}

function locationFromUnknown(value: unknown): LspLocation | undefined {
	if (!isObject(value)) return undefined
	const uri = objectProperty(value, 'uri')
	const range = normalizeRange(objectProperty(value, 'range'))
	return typeof uri === 'string' && range !== undefined ? { uri, range } : undefined
}

function locationLinkFromUnknown(value: unknown): LspLocationLink | undefined {
	if (!isObject(value)) return undefined
	const targetUri = objectProperty(value, 'targetUri')
	const targetRange = normalizeRange(objectProperty(value, 'targetRange'))
	const targetSelectionRange = normalizeRange(objectProperty(value, 'targetSelectionRange'))
	if (typeof targetUri !== 'string' || targetRange === undefined) return undefined
	return targetSelectionRange === undefined
		? { targetUri, targetRange }
		: { targetUri, targetRange, targetSelectionRange }
}

async function normalizeLocation(
	workspace: string,
	value: unknown,
): Promise<NormalizedLocation | undefined> {
	const location = locationFromUnknown(value)
	const link = location === undefined ? locationLinkFromUnknown(value) : undefined
	const uri = location?.uri ?? link?.targetUri
	const range = location?.range ?? link?.targetSelectionRange ?? link?.targetRange
	if (uri === undefined || range === undefined) return undefined
	const absolutePath = uriToFilePath(uri)
	const filePath = absolutePath === undefined ? uri : workspaceRelative(workspace, absolutePath)
	const text = absolutePath === undefined ? undefined : await readRangeText(absolutePath, range)
	return text === undefined ? { uri, filePath, range } : { uri, filePath, range, text }
}

async function readRangeText(filePath: string, range: LspRange): Promise<string | undefined> {
	try {
		return textForRange(await readFile(filePath, 'utf8'), range)
	} catch {
		return undefined
	}
}

function requestErrorMessage(method: string, error: unknown): string {
	if (isObject(error)) {
		const message = objectProperty(error, 'message')
		if (typeof message === 'string') return `${method}: ${message}`
	}
	return `${method}: ${describeUnknown(error)}`
}

class LspConnection {
	readonly config: LspServerConfig
	readonly workspace: string
	capabilities: unknown = undefined
	private readonly process: ChildProcessWithoutNullStreams
	private readonly pending = new Map<JsonRpcId, PendingRequest>()
	private stdout = Buffer.alloc(0)
	private stderr = ''
	private nextId = 1
	private closed = false

	private constructor(
		config: LspServerConfig,
		workspace: string,
		process: ChildProcessWithoutNullStreams,
	) {
		this.config = config
		this.workspace = workspace
		this.process = process
	}

	static async start(config: LspServerConfig, workspace: string, timeoutMs: number) {
		const [command, ...args] = config.command
		if (command === undefined) throw new Error(`LSP server ${config.id} has no command.`)
		const child = spawn(command, args, {
			cwd: workspace,
			env: { ...process.env, ...config.env },
			stdio: 'pipe',
		})
		const connection = new LspConnection(config, workspace, child)
		child.stdout.on('data', (chunk: Buffer) => connection.handleStdout(chunk))
		child.stderr.on('data', (chunk: Buffer) => connection.handleStderr(chunk))
		child.on('exit', () => connection.closePending('LSP server exited.'))
		child.on('error', (error) => connection.closePending(describeUnknown(error)))

		try {
			const initialized = await connection.request(
				'initialize',
				connection.initializeParams(),
				timeoutMs,
			)
			connection.capabilities = isObject(initialized)
				? objectProperty(initialized, 'capabilities')
				: undefined
			await connection.notify('initialized', {})
			return connection
		} catch (error) {
			connection.abort(`LSP initialize failed: ${describeUnknown(error)}`)
			throw error
		}
	}

	async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		if (this.closed) throw new Error('LSP connection is closed.')
		const id = this.nextId
		this.nextId += 1
		const response = new Promise<unknown>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error(`${method} timed out after ${timeoutMs}ms.`))
			}, timeoutMs)
			this.pending.set(id, { method, resolve, reject, timeout })
		})
		try {
			await this.send({ jsonrpc: '2.0', id, method, params })
		} catch (error) {
			const pending = this.pending.get(id)
			if (pending !== undefined) {
				clearTimeout(pending.timeout)
				this.pending.delete(id)
			}
			throw error
		}
		return response
	}

	async notify(method: string, params: unknown): Promise<void> {
		if (this.closed) return
		await this.send({ jsonrpc: '2.0', method, params })
	}

	async openDocument(filePath: string): Promise<LspDocument> {
		const uri = fileUri(filePath)
		const content = await readFile(filePath, 'utf8')
		await this.notify('textDocument/didOpen', {
			textDocument: {
				uri,
				languageId: languageId(filePath, this.config),
				version: 1,
				text: content,
			},
		})
		return { uri, content }
	}

	async closeDocument(document: LspDocument): Promise<void> {
		await this.notify('textDocument/didClose', { textDocument: { uri: document.uri } })
	}

	async disposeDocument(document: LspDocument): Promise<void> {
		try {
			await this.closeDocument(document)
		} catch (error) {
			this.abort(`Unable to close LSP document: ${describeUnknown(error)}`)
		}
	}

	async shutdown(): Promise<void> {
		if (this.closed) return
		try {
			await this.request('shutdown', null, 1_000)
		} catch {
			// Shutdown is best-effort; the process is still retired below.
		}
		try {
			await this.notify('exit', null)
		} catch {
			// Exit notification cannot help if stdin is already closed.
		}
		this.closed = true
		this.closePending('LSP connection disposed.')
		const killTimer = setTimeout(() => {
			if (!this.process.killed) this.process.kill()
		}, 1_000)
		killTimer.unref?.()
		this.process.once('exit', () => clearTimeout(killTimer))
	}

	private initializeParams() {
		return {
			processId: process.pid,
			rootPath: this.workspace,
			rootUri: fileUri(this.workspace),
			workspaceFolders: [{ uri: fileUri(this.workspace), name: path.basename(this.workspace) }],
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
			initializationOptions: this.config.initialization,
		}
	}

	private async send(message: unknown): Promise<void> {
		if (!this.process.stdin.writable) throw new Error('LSP server stdin is closed.')
		const body = JSON.stringify(message)
		const frame = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
		await new Promise<void>((resolve, reject) => {
			this.process.stdin.write(frame, (error) => {
				if (error === undefined || error === null) resolve()
				else reject(error)
			})
		})
	}

	private sendResponse(id: JsonRpcId, result: unknown): void {
		this.sendBestEffort({ jsonrpc: '2.0', id, result })
	}

	private sendErrorResponse(id: JsonRpcId, code: number, message: string): void {
		this.sendBestEffort({ jsonrpc: '2.0', id, error: { code, message } })
	}

	private sendBestEffort(message: unknown): void {
		void this.send(message).catch((error: unknown) => {
			this.abort(`Unable to write LSP response: ${describeUnknown(error)}`)
		})
	}

	private handleStdout(chunk: Buffer): void {
		this.stdout = Buffer.concat([this.stdout, chunk])
		if (this.stdout.length > 1024 * 1024 * 16) {
			this.closePending('LSP server emitted too much unframed stdout.')
			this.process.kill()
			return
		}
		while (true) {
			const headerEnd = this.stdout.indexOf('\r\n\r\n')
			if (headerEnd === -1) return
			const header = this.stdout.subarray(0, headerEnd).toString('ascii')
			const lengthMatch = /^Content-Length:\s*(\d+)$/imu.exec(header)
			if (lengthMatch === null) {
				this.stdout = this.stdout.subarray(headerEnd + 4)
				continue
			}
			const length = Number(lengthMatch[1])
			const bodyStart = headerEnd + 4
			const bodyEnd = bodyStart + length
			if (this.stdout.length < bodyEnd) return
			const body = this.stdout.subarray(bodyStart, bodyEnd).toString('utf8')
			this.stdout = this.stdout.subarray(bodyEnd)
			this.handleMessage(body)
		}
	}

	private handleStderr(chunk: Buffer): void {
		this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-16_384)
	}

	private handleMessage(body: string): void {
		let message: JsonRpcMessage
		try {
			const parsed = JSON.parse(body) as unknown
			if (!isObject(parsed)) return
			message = parsed
		} catch {
			return
		}

		if (message.id !== undefined && typeof message.method === 'string') {
			if (typeof message.id === 'number' || typeof message.id === 'string') {
				const response = this.serverRequestResponse(message.method, message.params)
				if (response.supported) this.sendResponse(message.id, response.result)
				else {
					this.sendErrorResponse(
						message.id,
						-32601,
						`Unsupported client request: ${message.method}`,
					)
				}
			}
			return
		}

		const id = message.id
		if (typeof id !== 'number' && typeof id !== 'string') return
		const pending = this.pending.get(id)
		if (pending === undefined) return
		this.pending.delete(id)
		clearTimeout(pending.timeout)
		if (message.error !== undefined) {
			pending.reject(new Error(requestErrorMessage(pending.method, message.error)))
		} else {
			pending.resolve(message.result)
		}
	}

	private serverRequestResponse(
		method: string,
		params: unknown,
	): { readonly supported: true; readonly result: unknown } | { readonly supported: false } {
		if (method === 'workspace/configuration') {
			const items = isObject(params) ? objectProperty(params, 'items') : undefined
			return { supported: true, result: Array.isArray(items) ? items.map(() => null) : [] }
		}
		if (
			method === 'client/registerCapability' ||
			method === 'client/unregisterCapability' ||
			method === 'window/workDoneProgress/create'
		) {
			return { supported: true, result: null }
		}
		return { supported: false }
	}

	private closePending(message: string): void {
		const stderr = this.stderr.trim()
		const detail = stderr.length === 0 ? message : `${message}\n${stderr}`
		this.closed = true
		for (const [id, pending] of this.pending.entries()) {
			clearTimeout(pending.timeout)
			pending.reject(new Error(`${pending.method}: ${detail}`))
			this.pending.delete(id)
		}
	}

	private abort(message: string): void {
		this.closePending(message)
		if (!this.process.killed) this.process.kill()
	}
}

async function withConnection<T>(
	config: LspServerConfig,
	workspace: string,
	timeoutMs: number,
	use: (connection: LspConnection) => Promise<T>,
): Promise<T> {
	const connection = await LspConnection.start(config, workspace, timeoutMs)
	try {
		return await use(connection)
	} finally {
		await connection.shutdown()
	}
}

async function runOnCapableServer<T>(
	tool: string,
	workspace: string,
	servers: ReadonlyArray<LspServerConfig>,
	capability: string,
	timeoutMs: number,
	use: (connection: LspConnection) => Promise<T>,
): Promise<T> {
	const errors: Array<string> = []
	for (const config of servers) {
		try {
			return await withConnection(config, workspace, timeoutMs, async (connection) => {
				if (!hasCapability(connection.capabilities, capability)) {
					throw new Error(`Server ${config.id} does not support ${capability}.`)
				}
				return use(connection)
			})
		} catch (error) {
			errors.push(`${config.id}: ${describeUnknown(error)}`)
		}
	}
	throw lspError(
		tool,
		`No matching LSP server completed ${capability}. ${errors.join('; ') || 'No candidates.'}`,
	)
}

function resolveFile(
	tool: string,
	workspace: string,
	input: { readonly filePath?: string | undefined; readonly path?: string | undefined },
): string {
	const filePath = input.filePath ?? input.path
	if (filePath === undefined || filePath.length === 0) {
		throw lspError(tool, 'filePath or path is required.')
	}
	return workspacePath(workspace, filePath)
}

function requireCandidates(
	tool: string,
	servers: ReadonlyArray<LspServerConfig>,
	filePath: string | undefined,
	serverId: string | undefined,
) {
	const candidates = matchingServers(servers, filePath, serverId)
	if (candidates.length === 0) {
		const target = serverId ?? (filePath === undefined ? 'workspace' : pathExtension(filePath))
		throw lspError(tool, `No configured LSP server matches ${target}.`)
	}
	return candidates
}

function maybeLimit<T>(items: ReadonlyArray<T>, maxResults: number | undefined) {
	const integerLimit = integer(maxResults)
	if (integerLimit === undefined || integerLimit <= 0) return { items, truncated: false }
	return { items: items.slice(0, integerLimit), truncated: items.length > integerLimit }
}

async function normalizeLocations(
	workspace: string,
	locations: ReadonlyArray<unknown>,
): Promise<ReadonlyArray<NormalizedLocation>> {
	const normalized: Array<NormalizedLocation> = []
	for (const location of locations) {
		const item = await normalizeLocation(workspace, location)
		if (item !== undefined) normalized.push(item)
	}
	return normalized
}

function symbolKind(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined
}

function normalizeDocumentSymbol(
	value: unknown,
	workspace: string,
	uri: string,
): NormalizedSymbol | undefined {
	if (!isObject(value)) return undefined
	const name = objectProperty(value, 'name')
	const range = normalizeRange(objectProperty(value, 'range'))
	const selectionRange = normalizeRange(objectProperty(value, 'selectionRange'))
	if (typeof name !== 'string' || range === undefined || selectionRange === undefined) {
		return normalizeSymbolInformation(value, workspace)
	}
	const detail = objectProperty(value, 'detail')
	const children = objectProperty(value, 'children')
	const absolutePath = uriToFilePath(uri)
	const kind = symbolKind(objectProperty(value, 'kind'))
	const normalizedChildren = Array.isArray(children)
		? children
				.map((child) => normalizeDocumentSymbol(child, workspace, uri))
				.filter((child) => child !== undefined)
		: undefined
	return {
		name,
		filePath: absolutePath === undefined ? uri : workspaceRelative(workspace, absolutePath),
		...(kind === undefined ? {} : { kind }),
		...(typeof detail === 'string' ? { detail } : {}),
		range,
		selectionRange,
		...(normalizedChildren === undefined ? {} : { children: normalizedChildren }),
	}
}

function normalizeSymbolInformation(
	value: unknown,
	workspace: string,
): NormalizedSymbol | undefined {
	if (!isObject(value)) return undefined
	const name = objectProperty(value, 'name')
	if (typeof name !== 'string') return undefined
	const location = locationFromUnknown(objectProperty(value, 'location'))
	const uri = location?.uri
	const absolutePath = uri === undefined ? undefined : uriToFilePath(uri)
	const containerName = objectProperty(value, 'containerName')
	const kind = symbolKind(objectProperty(value, 'kind'))
	return {
		name,
		...(kind === undefined ? {} : { kind }),
		...(typeof containerName === 'string' ? { detail: containerName } : {}),
		...(absolutePath === undefined
			? uri === undefined
				? {}
				: { filePath: uri }
			: { filePath: workspaceRelative(workspace, absolutePath) }),
		...(location === undefined ? {} : { range: location.range }),
	}
}

function textEditFromUnknown(
	value: unknown,
	workspace: string,
	uri: string,
): NormalizedEdit | undefined {
	if (!isObject(value)) return undefined
	const range = normalizeRange(objectProperty(value, 'range'))
	const newText = objectProperty(value, 'newText')
	if (range === undefined || typeof newText !== 'string') return undefined
	const absolutePath = uriToFilePath(uri)
	return {
		filePath: absolutePath === undefined ? uri : workspaceRelative(workspace, absolutePath),
		range,
		newText,
	}
}

function collectWorkspaceEdits(workspace: string, workspaceEdit: unknown): WorkspaceEditPreview {
	if (!isObject(workspaceEdit)) return { edits: [], unsupportedChanges: [] }
	const edits: Array<NormalizedEdit> = []
	const unsupportedChanges: Array<unknown> = []
	const changes = objectProperty(workspaceEdit, 'changes')
	if (isObject(changes)) {
		for (const [uri, rawEdits] of Object.entries(changes)) {
			if (!Array.isArray(rawEdits)) continue
			for (const rawEdit of rawEdits) {
				const edit = textEditFromUnknown(rawEdit, workspace, uri)
				if (edit !== undefined) edits.push(edit)
			}
		}
	}

	const documentChanges = objectProperty(workspaceEdit, 'documentChanges')
	if (Array.isArray(documentChanges)) {
		for (const documentChange of documentChanges) {
			if (!isObject(documentChange)) continue
			const textDocument = objectProperty(documentChange, 'textDocument')
			const uri = isObject(textDocument) ? objectProperty(textDocument, 'uri') : undefined
			const rawEdits = objectProperty(documentChange, 'edits')
			if (typeof uri !== 'string' || !Array.isArray(rawEdits)) {
				unsupportedChanges.push(documentChange)
				continue
			}
			for (const rawEdit of rawEdits) {
				const edit = textEditFromUnknown(rawEdit, workspace, uri)
				if (edit !== undefined) edits.push(edit)
			}
		}
	}
	return { edits, unsupportedChanges }
}

export function lspReferences(
	pluginInput: PluginInput,
	input: LspReferencesInput,
	context: ToolContext,
) {
	return Effect.gen(function* () {
		const workspace = workspaceRoot(input, context)
		const filePath = resolveFile('lsp_references', workspace, input)
		const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
		const configs = yield* loadServerConfigs(pluginInput, 'lsp_references', workspace)
		const candidates = requireCandidates('lsp_references', configs, filePath, input.server)
		return yield* Effect.tryPromise({
			try: async () =>
				runOnCapableServer(
					'lsp_references',
					workspace,
					candidates,
					'referencesProvider',
					timeoutMs,
					async (connection) => {
						const document = await connection.openDocument(filePath)
						try {
							const position = resolvePosition('lsp_references', document.content, input)
							const raw = await connection.request(
								'textDocument/references',
								{
									textDocument: { uri: document.uri },
									position,
									context: { includeDeclaration: input.includeDeclaration ?? true },
								},
								timeoutMs,
							)
							const rawLocations = Array.isArray(raw) ? raw : []
							const limitedRaw = maybeLimit(rawLocations, input.maxResults)
							const locations = await normalizeLocations(workspace, limitedRaw.items)
							return {
								ok: true,
								tool: 'lsp_references',
								server: connection.config.id,
								filePath: workspaceRelative(workspace, filePath),
								position,
								locations,
								truncated: limitedRaw.truncated,
							}
						} finally {
							await connection.disposeDocument(document)
						}
					},
				),
			catch: (error) =>
				error instanceof LspToolError ? error : lspError('lsp_references', describeUnknown(error)),
		})
	})
}

export function lspSymbols(pluginInput: PluginInput, input: LspSymbolsInput, context: ToolContext) {
	return Effect.gen(function* () {
		const workspace = workspaceRoot(input, context)
		const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
		const filePathInput = input.filePath ?? input.path
		const filePath =
			filePathInput === undefined ? undefined : workspacePath(workspace, filePathInput)
		const configs = yield* loadServerConfigs(pluginInput, 'lsp_symbols', workspace)
		const candidates = requireCandidates('lsp_symbols', configs, filePath, input.server)
		return yield* Effect.tryPromise({
			try: async () => {
				if (input.query !== undefined) {
					const symbols: Array<NormalizedSymbol> = []
					const errors: Array<Record<string, string>> = []
					for (const config of candidates) {
						try {
							const result = await runOnCapableServer(
								'lsp_symbols',
								workspace,
								[config],
								'workspaceSymbolProvider',
								timeoutMs,
								(connection) =>
									connection.request('workspace/symbol', { query: input.query }, timeoutMs),
							)
							if (Array.isArray(result)) {
								for (const item of result) {
									const symbol = normalizeSymbolInformation(item, workspace)
									if (symbol !== undefined) symbols.push(symbol)
								}
							}
						} catch (error) {
							errors.push({ server: config.id, message: describeUnknown(error) })
						}
					}
					if (symbols.length === 0 && errors.length > 0) {
						throw lspError(
							'lsp_symbols',
							`No workspace symbol provider succeeded. ${errors.map((error) => `${error.server}: ${error.message}`).join('; ')}`,
						)
					}
					const limited = maybeLimit(symbols, input.maxResults)
					return {
						ok: true,
						tool: 'lsp_symbols',
						mode: 'workspace',
						query: input.query,
						symbols: limited.items,
						truncated: limited.truncated,
						errors,
					}
				}

				if (filePath === undefined) {
					throw lspError(
						'lsp_symbols',
						'Provide filePath/path for document symbols or query plus filePath/server for workspace symbols.',
					)
				}
				return runOnCapableServer(
					'lsp_symbols',
					workspace,
					candidates,
					'documentSymbolProvider',
					timeoutMs,
					async (connection) => {
						const document = await connection.openDocument(filePath)
						try {
							const raw = await connection.request(
								'textDocument/documentSymbol',
								{ textDocument: { uri: document.uri } },
								timeoutMs,
							)
							const symbols = Array.isArray(raw)
								? raw
										.map((item) => normalizeDocumentSymbol(item, workspace, document.uri))
										.filter((symbol) => symbol !== undefined)
								: []
							const limited = maybeLimit(symbols, input.maxResults)
							return {
								ok: true,
								tool: 'lsp_symbols',
								mode: 'document',
								server: connection.config.id,
								filePath: workspaceRelative(workspace, filePath),
								symbols: limited.items,
								truncated: limited.truncated,
							}
						} finally {
							await connection.disposeDocument(document)
						}
					},
				)
			},
			catch: (error) =>
				error instanceof LspToolError ? error : lspError('lsp_symbols', describeUnknown(error)),
		})
	})
}

export function lspRename(pluginInput: PluginInput, input: LspRenameInput, context: ToolContext) {
	return Effect.gen(function* () {
		const workspace = workspaceRoot(input, context)
		const filePath = resolveFile('lsp_rename', workspace, input)
		const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
		const configs = yield* loadServerConfigs(pluginInput, 'lsp_rename', workspace)
		const candidates = requireCandidates('lsp_rename', configs, filePath, input.server)
		return yield* Effect.tryPromise({
			try: async () =>
				runOnCapableServer(
					'lsp_rename',
					workspace,
					candidates,
					'renameProvider',
					timeoutMs,
					async (connection) => {
						const document = await connection.openDocument(filePath)
						try {
							const position = resolvePosition('lsp_rename', document.content, input)
							if (hasPrepareRename(connection.capabilities)) {
								const prepare = await connection.request(
									'textDocument/prepareRename',
									{ textDocument: { uri: document.uri }, position },
									timeoutMs,
								)
								if (prepare === null) {
									throw lspError(
										'lsp_rename',
										'Server rejected rename at this position.',
										connection.config.id,
									)
								}
							}
							const workspaceEdit = await connection.request(
								'textDocument/rename',
								{
									textDocument: { uri: document.uri },
									position,
									newName: input.newName,
								},
								timeoutMs,
							)
							const preview = collectWorkspaceEdits(workspace, workspaceEdit)
							return {
								ok: preview.unsupportedChanges.length === 0,
								tool: 'lsp_rename',
								server: connection.config.id,
								filePath: workspaceRelative(workspace, filePath),
								position,
								newName: input.newName,
								mode: 'preview',
								applied: false,
								edits: preview.edits,
								unsupportedChanges: preview.unsupportedChanges,
							}
						} finally {
							await connection.disposeDocument(document)
						}
					},
				),
			catch: (error) =>
				error instanceof LspToolError ? error : lspError('lsp_rename', describeUnknown(error)),
		})
	})
}
