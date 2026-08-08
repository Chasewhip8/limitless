import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'

const productionDirectory = fileURLToPath(new URL('..', import.meta.url))
const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url))
const rootIndex = path.join(productionDirectory, 'index.ts')
const toolBoundary = path.join(productionDirectory, 'core', 'tool-boundary.ts')
const exampleDocsScript = path.join(workspaceRoot, 'scripts', 'generate-example-docs.ts')
const limitlessPackage = path.join(productionDirectory, 'package.json')
const lspDirectory = path.join(productionDirectory, 'tools', 'lsp')

const allowedLayout = new Map<string, ReadonlySet<string>>([
	['.', new Set(['index.ts'])],
	[
		'core',
		new Set([
			'command.ts',
			'errors.ts',
			'filesystem.ts',
			'paths.ts',
			'storage.ts',
			'tool-boundary.ts',
		]),
	],
	['lib', new Set(['guards.ts', 'type-utils.ts'])],
	['tools', new Set(['ast-grep.ts', 'diagnostics.ts'])],
	[
		'tools/artifacts',
		new Set([
			'create.ts',
			'filesystem.ts',
			'index.ts',
			'list.ts',
			'paths.ts',
			'schema.ts',
			'templates.ts',
			'tools.ts',
			'typst.ts',
		]),
	],
	[
		'tools/github',
		new Set([
			'checkout.ts',
			'clone-schema.ts',
			'clone.ts',
			'config.ts',
			'errors.ts',
			'git.ts',
			'index.ts',
			'repository.ts',
			'runtime.ts',
			'schema.ts',
			'submodules.ts',
			'tools.ts',
		]),
	],
	[
		'tools/lsp',
		new Set([
			'call-hierarchy.ts',
			'config.ts',
			'connection.ts',
			'definition.ts',
			'errors.ts',
			'hover.ts',
			'implementation.ts',
			'index.ts',
			'locations.ts',
			'references.ts',
			'rename.ts',
			'runtime.ts',
			'schema.ts',
			'symbols.ts',
			'tools.ts',
		]),
	],
	[
		'integrations/notifications',
		new Set(['config.ts', 'events.ts', 'index.ts', 'runner.ts', 'schema.ts']),
	],
	[
		'integrations/slack',
		new Set([
			'config.ts',
			'errors.ts',
			'history.ts',
			'index.ts',
			'runner.ts',
			'runtime.ts',
			'schema.ts',
			'tools.ts',
		]),
	],
])

const operationalTypes = new Map([
	['core/command.ts', new Set(['RunOptions'])],
	['tools/github/runtime.ts', new Set(['GitRuntime', 'GitHubCloneRuntime'])],
	['tools/lsp/runtime.ts', new Set(['LspRuntimeState', 'LspConnectionRuntime'])],
	[
		'integrations/slack/runtime.ts',
		new Set([
			'SlackMentionDispatcher',
			'SlackAppHandle',
			'SlackAppFactory',
			'SlackRunnerOptions',
			'SlackThreadState',
			'SlackPendingTurn',
			'SlackActiveTurn',
			'SlackRuntimeState',
			'SlackPluginContext',
			'SlackRunnerConfig',
		]),
	],
	['integrations/slack/runner.ts', new Set(['SlackRunner'])],
])

const operationSchemas = new Map<string, ReadonlySet<string>>([
	[
		'tools/artifacts/create.ts',
		new Set(['ArtifactTitleInput', 'ArtifactCreateInput', 'ArtifactCreateResult']),
	],
	[
		'tools/artifacts/list.ts',
		new Set([
			'ArtifactListInput',
			'ArtifactListEntry',
			'InvalidArtifactListEntry',
			'ArtifactListResult',
		]),
	],
	[
		'tools/artifacts/templates.ts',
		new Set([
			'ArtifactTemplateFilePath',
			'ArtifactTemplate',
			'InvalidArtifactTemplate',
			'ArtifactTemplatesListInput',
			'ArtifactTemplatesListResult',
			'ArtifactTemplateReadInput',
			'ArtifactTemplateReadResult',
		]),
	],
	[
		'tools/artifacts/typst.ts',
		new Set([
			'TypstEntryFile',
			'TypstFormat',
			'TypstCompileInput',
			'TypstCompileOptions',
			'TypstCompileResult',
		]),
	],
	[
		'tools/github/clone-schema.ts',
		new Set([
			'GitConfigEntry',
			'GitHubCloneOptions',
			'GitHubCloneState',
			'GitHubCloneInput',
			'GitHubCloneErrorPayload',
			'GitHubCloneSuccess',
			'GitHubCloneFailureResult',
			'GitHubCloneResult',
		]),
	],
	[
		'tools/lsp/locations.ts',
		new Set([
			'LspLocationLink',
			'LspLocationResult',
			'LspLocationArrayResponse',
			'LspLocationResponse',
			'NormalizedLocation',
		]),
	],
	['tools/lsp/references.ts', new Set(['LspReferencesInput', 'LspReferencesResult'])],
	[
		'tools/lsp/definition.ts',
		new Set([
			'LspDefinitionRelationship',
			'LspDefinitionLocation',
			'LspDefinitionRelationshipError',
			'LspDefinitionInput',
			'LspDefinitionResult',
		]),
	],
	[
		'tools/lsp/hover.ts',
		new Set([
			'LspMarkupContent',
			'LspMarkedCode',
			'LspMarkedString',
			'LspHoverResponse',
			'LspHoverContent',
			'NormalizedHover',
			'LspHoverInput',
			'LspHoverResult',
		]),
	],
	['tools/lsp/implementation.ts', new Set(['LspImplementationInput', 'LspImplementationResult'])],
	[
		'tools/lsp/call-hierarchy.ts',
		new Set([
			'LspCallHierarchyItem',
			'LspCallHierarchyPrepareResponse',
			'LspCallHierarchyIncomingCall',
			'LspCallHierarchyOutgoingCall',
			'LspCallHierarchyIncomingResponse',
			'LspCallHierarchyOutgoingResponse',
			'NormalizedCallHierarchyItem',
			'LspIncomingCall',
			'LspOutgoingCall',
			'LspCallHierarchyDirectionError',
			'LspPreparedCallHierarchy',
			'LspCallHierarchyInput',
			'LspCallHierarchyResult',
		]),
	],
	[
		'tools/lsp/symbols.ts',
		new Set([
			'LspSymbolsInput',
			'LspWorkspaceSymbolError',
			'LspDocumentSymbolsResult',
			'LspWorkspaceSymbolsResult',
			'LspSymbolsResult',
			'NormalizedSymbol',
			'NormalizedSymbolModel',
			'LspSymbolInformation',
			'LspDocumentSymbol',
			'LspDocumentSymbolModel',
			'LspDocumentSymbolsResponse',
			'LspWorkspaceSymbolLocation',
			'LspWorkspaceSymbol',
			'LspWorkspaceSymbolsResponse',
		]),
	],
	[
		'tools/lsp/rename.ts',
		new Set([
			'LspRenameInput',
			'LspRenameResultFields',
			'LspCompleteRenameResult',
			'LspPartialRenameResult',
			'LspRenameResult',
			'NormalizedEdit',
			'WorkspaceEditPreview',
			'LspPrepareRenameResponse',
			'LspTextEdit',
			'LspTextDocumentEdit',
			'LspWorkspaceEdit',
			'LspRenameResponse',
		]),
	],
])
const operationSchemaOwners = new Map(
	[...operationSchemas].flatMap(([owner, names]) =>
		[...names].map((name) => [name, owner] as const),
	),
)

const barrelSurfaces = new Map<string, ReadonlySet<string>>([
	[
		'tools/artifacts/index.ts',
		new Set([
			'ArtifactCreateInput',
			'ArtifactSlug',
			'ArtifactTemplatesListInput',
			'artifactCreate',
			'artifactTemplatesList',
			'artifactTools',
			'artifactsRoot',
			'decodeArtifactSlug',
			'typstCompile',
		]),
	],
	[
		'tools/github/index.ts',
		new Set([
			'DISABLED_GITHUB_CONFIG',
			'githubTools',
			'makeGitHubCloneRuntime',
			'normalizeGitHubPluginConfig',
		]),
	],
	['tools/lsp/index.ts', new Set(['lspTools'])],
	[
		'integrations/notifications/index.ts',
		new Set([
			'DEFAULT_NOTIFICATION_TIMEOUT_MS',
			'DISABLED_NOTIFICATION_CONFIG',
			'NotificationConfig',
			'NotificationConfigError',
			'createNotificationRunner',
			'normalizeNotificationConfig',
		]),
	],
	[
		'integrations/slack/index.ts',
		new Set([
			'DEFAULT_SLACK_AGENT',
			'DEFAULT_SLACK_APP_TOKEN_ENV',
			'DEFAULT_SLACK_BOT_TOKEN_ENV',
			'DISABLED_SLACK_CONFIG',
			'MAX_SLACK_IMAGE_BYTES',
			'MAX_SLACK_IMAGES_PER_TURN',
			'MAX_SLACK_MARKDOWN_CHARS',
			'MAX_SLACK_STATUS_CHARS',
			'SLACK_SERVICE_ACTIVATION_ENV',
			'SlackConfig',
			'SlackConfigError',
			'SlackRunner',
			'SlackStatusInput',
			'chunkSlackMarkdown',
			'createSlackRunner',
			'isSlackCancelCommand',
			'normalizeSlackConfig',
			'selectSlackImageIDs',
			'slackThreadKey',
			'slackTools',
			'stripSlackBotMention',
		]),
	],
])

function relativePath(filePath: string): string {
	return path.relative(productionDirectory, filePath).split(path.sep).join(path.posix.sep)
}

function isAllowedLayout(relative: string): boolean {
	const directory = path.posix.dirname(relative)
	return allowedLayout.get(directory)?.has(path.posix.basename(relative)) === true
}

function location(sourceFile: ts.SourceFile, node: ts.Node): string {
	const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
	return `${relativePath(sourceFile.fileName)}:${position.line + 1}:${position.character + 1}`
}

function effectImportBindings(
	sourceFile: ts.SourceFile,
	exportedName: string,
): ReadonlySet<string> {
	const bindings = new Set<string>()
	for (const statement of sourceFile.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier) ||
			statement.moduleSpecifier.text !== 'effect' ||
			statement.importClause?.namedBindings === undefined ||
			!ts.isNamedImports(statement.importClause.namedBindings)
		)
			continue
		for (const element of statement.importClause.namedBindings.elements) {
			if ((element.propertyName ?? element.name).text === exportedName)
				bindings.add(element.name.text)
		}
	}
	return bindings
}

function isModuleScope(node: ts.Node, sourceFile: ts.SourceFile): boolean {
	let current: ts.Node | undefined = node.parent
	while (current !== undefined && current !== sourceFile) {
		if (ts.isFunctionLike(current)) return false
		current = current.parent
	}
	return current === sourceFile
}

function isSchemaDerivedAlias(node: ts.TypeAliasDeclaration, sourceFile: ts.SourceFile): boolean {
	return /^typeof\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.Type$/u.test(
		node.type.getText(sourceFile),
	)
}

function declarationNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
	const names = new Set<string>()
	for (const statement of sourceFile.statements) {
		if (
			ts.isClassDeclaration(statement) ||
			ts.isFunctionDeclaration(statement) ||
			ts.isInterfaceDeclaration(statement) ||
			ts.isTypeAliasDeclaration(statement)
		) {
			if (statement.name !== undefined) names.add(statement.name.text)
			continue
		}
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
			}
		}
	}
	return names
}

function barrelExportNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
	const names = new Set<string>()
	for (const statement of sourceFile.statements) {
		if (!ts.isExportDeclaration(statement) || statement.exportClause === undefined) continue
		if (!ts.isNamedExports(statement.exportClause)) continue
		for (const element of statement.exportClause.elements) names.add(element.name.text)
	}
	return names
}

function visit(
	sourceFile: ts.SourceFile,
	node: ts.Node,
	violations: Array<string>,
	effectBindings: ReadonlySet<string>,
	schemaBindings: ReadonlySet<string>,
): void {
	const relative = relativePath(sourceFile.fileName)
	const isScript = sourceFile.fileName === exampleDocsScript
	if (ts.isInterfaceDeclaration(node))
		violations.push(`${location(sourceFile, node)} handwritten interface declaration`)
	if (
		ts.isTypeAliasDeclaration(node) &&
		!isSchemaDerivedAlias(node, sourceFile) &&
		!operationalTypes.get(relative)?.has(node.name.text)
	) {
		violations.push(`${location(sourceFile, node)} handwritten serializable type declaration`)
	}
	const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
	if (
		sourceFile.fileName !== rootIndex &&
		modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
	) {
		violations.push(`${location(sourceFile, node)} async implementation outside root index.ts`)
	}
	if (
		ts.isPropertyAccessExpression(node) &&
		ts.isIdentifier(node.expression) &&
		effectBindings.has(node.expression.text) &&
		node.name.text === 'runPromise'
	) {
		const allowed =
			sourceFile.fileName === rootIndex ||
			sourceFile.fileName === toolBoundary ||
			(isScript && isModuleScope(node, sourceFile))
		if (!allowed)
			violations.push(`${location(sourceFile, node)} Effect.runPromise outside boundary modules`)
	}
	if (
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.name.text.endsWith('Unsafe') &&
		isModuleScope(node, sourceFile)
	) {
		violations.push(`${location(sourceFile, node)} top-level unsafe Effect primitive`)
	}
	if (
		ts.isTypeReferenceNode(node) &&
		node.typeName.getText(sourceFile).endsWith('Effect') &&
		node.typeArguments?.[1]?.kind === ts.SyntaxKind.UnknownKeyword
	) {
		violations.push(`${location(sourceFile, node)} unknown Effect error channel`)
	}
	if (
		ts.isPropertyAccessExpression(node) &&
		ts.isIdentifier(node.expression) &&
		schemaBindings.has(node.expression.text) &&
		node.name.text === 'decodeUnknownSync'
	) {
		violations.push(`${location(sourceFile, node)} Schema.decodeUnknownSync`)
	}
	ts.forEachChild(node, (child) =>
		visit(sourceFile, child, violations, effectBindings, schemaBindings),
	)
}

function moduleSpecifiers(sourceFile: ts.SourceFile): ReadonlyArray<string> {
	return sourceFile.statements.flatMap((statement) => {
		if (
			(!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
			statement.moduleSpecifier === undefined ||
			!ts.isStringLiteral(statement.moduleSpecifier)
		)
			return []
		return [statement.moduleSpecifier.text]
	})
}

function resolveRelativeImport(
	sourceFile: ts.SourceFile,
	specifier: string,
	productionFiles: ReadonlySet<string>,
): string | undefined {
	if (!specifier.startsWith('.')) return undefined
	const base = path.resolve(path.dirname(sourceFile.fileName), specifier)
	for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
		if (productionFiles.has(candidate)) return candidate
	}
	return undefined
}

function dependencyCycles(
	graph: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<string> {
	const state = new Map<string, 'visiting' | 'visited'>()
	const stack: Array<string> = []
	const cycles = new Set<string>()
	const visitNode = (node: string): void => {
		state.set(node, 'visiting')
		stack.push(node)
		for (const target of graph.get(node) ?? []) {
			if (!graph.has(target)) continue
			if (state.get(target) === 'visiting') {
				const start = stack.indexOf(target)
				cycles.add([...stack.slice(start), target].map(relativePath).join(' -> '))
			} else if (state.get(target) !== 'visited') visitNode(target)
		}
		stack.pop()
		state.set(node, 'visited')
	}
	for (const node of graph.keys()) if (state.get(node) === undefined) visitNode(node)
	return [...cycles].sort()
}

async function productionSources(): Promise<ReadonlyArray<ts.SourceFile>> {
	const entries = await readdir(productionDirectory, { recursive: true, withFileTypes: true })
	return Promise.all(
		entries
			.filter(
				(entry) =>
					entry.isFile() &&
					entry.name.endsWith('.ts') &&
					!entry.parentPath.split(path.sep).includes('node_modules') &&
					!entry.parentPath.includes(`${path.sep}test`),
			)
			.map(async (entry) => {
				const filePath = path.join(entry.parentPath, entry.name)
				return ts.createSourceFile(
					filePath,
					await readFile(filePath, 'utf8'),
					ts.ScriptTarget.Latest,
					true,
					ts.ScriptKind.TS,
				)
			}),
	)
}

describe('production architecture', () => {
	test('uses the official LSP protocol transport and typed methods', async () => {
		const manifest = JSON.parse(await readFile(limitlessPackage, 'utf8')) as {
			readonly dependencies: Readonly<Record<string, string>>
		}
		expect(manifest.dependencies['vscode-languageserver-protocol']).toBe('3.18.2')
		expect(manifest.dependencies['vscode-jsonrpc']).toBeUndefined()

		const connection = await readFile(path.join(lspDirectory, 'connection.ts'), 'utf8')
		const operations = await Promise.all(
			[
				'call-hierarchy.ts',
				'definition.ts',
				'hover.ts',
				'implementation.ts',
				'references.ts',
				'rename.ts',
				'symbols.ts',
			].map((file) => readFile(path.join(lspDirectory, file), 'utf8')),
		)
		const implementation = [connection, ...operations].join('\n')
		expect(connection).toContain('createProtocolConnection(child.stdout, child.stdin)')
		expect(connection).not.toMatch(
			/Content-Length|MAX_STDOUT_BUFFER_BYTES|JsonRpc|Queue|Semaphore/u,
		)
		for (const protocolType of [
			'InitializeRequest.type',
			'InitializedNotification.type',
			'ShutdownRequest.type',
			'ExitNotification.type',
			'DidOpenTextDocumentNotification.type',
			'DidCloseTextDocumentNotification.type',
			'DefinitionRequest.type',
			'DeclarationRequest.type',
			'TypeDefinitionRequest.type',
			'HoverRequest.type',
			'ImplementationRequest.type',
			'CallHierarchyPrepareRequest.type',
			'CallHierarchyIncomingCallsRequest.type',
			'CallHierarchyOutgoingCallsRequest.type',
			'ReferencesRequest.type',
			'DocumentSymbolRequest.type',
			'WorkspaceSymbolRequest.type',
			'PrepareRenameRequest.type',
			'RenameRequest.type',
			'PositionEncodingKind.UTF16',
			'ConfigurationRequest.type',
			'RegistrationRequest.type',
			'UnregistrationRequest.type',
			'WorkDoneProgressCreateRequest.type',
			'WorkspaceFoldersRequest.type',
		]) {
			expect(implementation).toContain(protocolType)
		}
	})

	test('explicitly includes every production subtree in TypeScript coverage', async () => {
		const config = ts.parseConfigFileTextToJson(
			path.join(workspaceRoot, 'tsconfig.json'),
			await readFile(path.join(workspaceRoot, 'tsconfig.json'), 'utf8'),
		).config as { readonly include?: ReadonlyArray<string> }
		expect(config.include).toEqual(
			expect.arrayContaining([
				'packages/limitless/core/**/*.ts',
				'packages/limitless/lib/**/*.ts',
				'packages/limitless/tools/**/*.ts',
				'packages/limitless/integrations/**/*.ts',
			]),
		)
	})

	test('enforces layout, ownership, acyclic imports, and Effect boundaries', async () => {
		const sourceFiles = await productionSources()
		const script = ts.createSourceFile(
			exampleDocsScript,
			await readFile(exampleDocsScript, 'utf8'),
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		)
		const violations: Array<string> = []
		const declarations = new Map<string, Set<string>>()
		const graph = new Map<string, ReadonlyArray<string>>()
		const productionFiles = new Set(sourceFiles.map((sourceFile) => sourceFile.fileName))

		for (const sourceFile of sourceFiles) {
			const relative = relativePath(sourceFile.fileName)
			if (!isAllowedLayout(relative)) violations.push(`${relative} is outside the allowed layout`)
			const names = declarationNames(sourceFile)
			for (const name of names) {
				const owners = declarations.get(name) ?? new Set<string>()
				owners.add(relative)
				declarations.set(name, owners)
			}
			visit(
				sourceFile,
				sourceFile,
				violations,
				effectImportBindings(sourceFile, 'Effect'),
				effectImportBindings(sourceFile, 'Schema'),
			)
			const specifiers = moduleSpecifiers(sourceFile)
			const targets = specifiers
				.map((specifier) => resolveRelativeImport(sourceFile, specifier, productionFiles))
				.filter((target): target is string => target !== undefined)
			graph.set(sourceFile.fileName, targets)

			if (
				(relative.startsWith('core/') || relative.startsWith('lib/')) &&
				targets.some(
					(target) =>
						relativePath(target).startsWith('tools/') ||
						relativePath(target).startsWith('integrations/'),
				)
			) {
				violations.push(`${relative} core/lib imports a feature adapter`)
			}
			if (relative.startsWith('lib/') && effectImportBindings(sourceFile, 'Schema').size > 0)
				violations.push(`${relative} domain schema in lib`)
			if (
				relative.startsWith('lib/') &&
				!new Set(['lib/guards.ts', 'lib/type-utils.ts']).has(relative)
			)
				violations.push(`${relative} is outside the narrow lib allowlist`)

			const isCoreOrLib = relative.startsWith('core/') || relative.startsWith('lib/')
			if (isCoreOrLib && relative !== 'core/storage.ts') {
				const forbidden = /\b(artifact|template|typst|github|notification|ast[- ]?grep)\b/iu
				if (forbidden.test(sourceFile.text))
					violations.push(`${relative} owns feature-specific vocabulary`)
			}
			if (isCoreOrLib && /\blsp\b/iu.test(sourceFile.text))
				violations.push(`${relative} owns LSP-specific vocabulary`)

			if (
				relative !== 'core/storage.ts' &&
				sourceFile.statements.some((statement) => {
					let found = false
					const inspect = (node: ts.Node): void => {
						if (ts.isStringLiteral(node) && node.text === '.limitless') found = true
						else ts.forEachChild(node, inspect)
					}
					inspect(statement)
					return found
				})
			)
				violations.push(`${relative} duplicates the .limitless storage root`)

			if (relative.endsWith('/schema.ts')) {
				for (const name of names) {
					if (operationSchemaOwners.has(name))
						violations.push(`${relative} owns operation-only schema ${name}`)
				}
			}

			if (relative.endsWith('/index.ts') && relative !== 'index.ts') continue
			const featureRoot = relative.match(
				/^(tools\/(?:artifacts|github|lsp)|integrations\/(?:notifications|slack))\//u,
			)?.[1]
			if (
				featureRoot !== undefined &&
				targets.some((target) => relativePath(target) === `${featureRoot}/index.ts`)
			)
				violations.push(`${relative} imports its feature barrel`)
		}

		visit(
			script,
			script,
			violations,
			effectImportBindings(script, 'Effect'),
			effectImportBindings(script, 'Schema'),
		)
		const scriptSpecifiers = moduleSpecifiers(script)
		const artifactsBarrel = '../packages/limitless/tools/artifacts/index'
		if (!scriptSpecifiers.includes(artifactsBarrel))
			violations.push(`example docs script must consume ${artifactsBarrel}`)
		for (const specifier of scriptSpecifiers) {
			if (
				specifier.startsWith('../packages/limitless/tools/artifacts/') &&
				specifier !== artifactsBarrel
			)
				violations.push(`example docs script deep-imports artifact implementation ${specifier}`)
		}
		const inspectScriptStorage = (node: ts.Node): void => {
			if (ts.isStringLiteral(node) && (node.text === '.limitless' || node.text === 'artifacts'))
				violations.push(`example docs script duplicates storage literal ${node.text}`)
			ts.forEachChild(node, inspectScriptStorage)
		}
		inspectScriptStorage(script)

		for (const [name, owner] of operationSchemaOwners) {
			const actual = declarations.get(name)
			if (actual === undefined || !actual.has(owner) || [...actual].some((file) => file !== owner))
				violations.push(`${name} must be declared only in ${owner}`)
		}

		for (const [barrel, expected] of barrelSurfaces) {
			const sourceFile = sourceFiles.find(
				(candidate) => relativePath(candidate.fileName) === barrel,
			)
			const actual = sourceFile === undefined ? new Set<string>() : barrelExportNames(sourceFile)
			if ([...actual].sort().join('\0') !== [...expected].sort().join('\0'))
				violations.push(
					`${barrel} exports ${[...actual].sort().join(', ')}; expected ${[...expected].sort().join(', ')}`,
				)
		}

		const rootSpecifiers = moduleSpecifiers(
			sourceFiles.find((sourceFile) => sourceFile.fileName === rootIndex) as ts.SourceFile,
		)
		for (const featureIndex of [
			'./integrations/notifications/index',
			'./integrations/slack/index',
			'./tools/artifacts/index',
			'./tools/github/index',
			'./tools/lsp/index',
		]) {
			if (!rootSpecifiers.includes(featureIndex))
				violations.push(`root index must compose ${featureIndex}`)
		}

		for (const cycle of dependencyCycles(graph)) violations.push(`relative import cycle: ${cycle}`)
		expect(violations).toEqual([])
	})
})
