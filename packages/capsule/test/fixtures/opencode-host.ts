// Runs under Bun in a child process with isolated HOME and XDG roots, because OpenCode resolves its
// global data, config, and credential paths from the environment when its modules load.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { NodeServices } from '@effect/platform-node'
import {
	AbsolutePath,
	Location,
	OpenCode,
	Workspace,
	type WorkspaceDriver,
} from '@opencode/sdk/effect'
import { Effect, FileSystem, Path, PlatformError, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as CapsuleWorkspace from '../../opencode'
import { CapsuleError, type CapsuleSpec, type Manifest, RuntimeSettings } from '../../schema'
import { Capsule, make as makeCapsule } from '../../service'

const Input = Schema.Struct({
	checkouts: Schema.Array(Schema.String),
	config: Schema.String,
	hostOnly: Schema.String,
	search: Schema.Boolean,
	runtime: Schema.optionalKey(Schema.Struct({ settings: RuntimeSettings, root: Schema.String })),
})
const input = Schema.decodeUnknownSync(Schema.fromJsonString(Input))(process.argv[2])

const refuse = (description: string) =>
	PlatformError.badArgument({ module: 'Fixture', method: 'spawn', description })

// Stands in for Capsule's Bubblewrap runtime with its environment contract, but runs commands on
// the host: the project environment is inherited unless a command replaces it, identity
// variables are reserved, and commands stay inside the checkout.
const controlledCapsule = Effect.gen(function* () {
	const host = yield* ChildProcessSpawner.ChildProcessSpawner
	const manifests = new Map<string, Manifest>()
	const require = (id: string) => {
		const manifest = manifests.get(id)
		if (manifest) return Effect.succeed(manifest)
		return Effect.fail(CapsuleError.make({ code: 'not_prepared', message: 'Not prepared.' }))
	}

	const confine = (
		command: ChildProcess.Command,
		spec: CapsuleSpec,
	): Effect.Effect<ChildProcess.Command, PlatformError.PlatformError> => {
		if (ChildProcess.isPipedCommand(command)) {
			return Effect.gen(function* () {
				const left = yield* confine(command.left, spec)
				const right = yield* confine(command.right, spec)
				return ChildProcess.pipeTo(left, right, command.options)
			})
		}
		const { cwd = spec.directory, env, extendEnv } = command.options
		if (cwd !== spec.directory && !cwd.startsWith(`${spec.directory}/`)) {
			return Effect.fail(refuse('The working directory is outside the checkout.'))
		}
		const project = { PATH: process.env.PATH ?? '', CAPSULE_FIXTURE: 'project' }
		const inherited = env === undefined || extendEnv === true ? project : {}
		return Effect.succeed(
			ChildProcess.make(command.command, command.args, {
				...command.options,
				cwd,
				env: { PATH: project.PATH, ...inherited, ...env, CAPSULE_ID: spec.id },
				extendEnv: false,
			}),
		)
	}

	return Capsule.of({
		prepare: (spec: CapsuleSpec) =>
			Effect.sync(() => {
				const existing = manifests.get(spec.id)
				if (existing?.phase === 'ready') return existing
				const manifest: Manifest = {
					owner: 'limitless-capsule-v1',
					spec,
					generation: (existing?.generation ?? 0) + 1,
					phase: 'ready',
				}
				manifests.set(spec.id, manifest)
				return manifest
			}),
		inspect: (id) => Effect.sync(() => manifests.get(id)),
		connect: (id) =>
			Effect.map(require(id), ({ spec }) =>
				ChildProcessSpawner.make((command) =>
					Effect.flatMap(confine(command, spec), (confined) => host.spawn(confined)),
				),
			),
		stop: require,
		purge: (id) =>
			Effect.sync(() => {
				const manifest = manifests.get(id)
				if (manifest === undefined) return undefined
				const purged: Manifest = {
					...manifest,
					phase: 'purged',
					generation: manifest.generation + 1,
				}
				manifests.set(id, purged)
				return purged
			}),
	})
})

// Records what OpenCode asks of Capsule, including every command and the spawner it reached.
const recorded = (capsule: Capsule['Service']) => {
	const operations: Array<string> = []
	const spawned: Array<{ readonly capsule: string; readonly words: ReadonlyArray<string> }> = []
	const words = (command: ChildProcess.Command): ReadonlyArray<string> =>
		ChildProcess.isPipedCommand(command)
			? [...words(command.left), '|', ...words(command.right)]
			: [command.command, ...command.args.map(String), command.options.cwd ?? '']
	const service = Capsule.of({
		...capsule,
		prepare: (spec, refresh) =>
			Effect.suspend(() => {
				operations.push(`prepare:${spec.id}`)
				return capsule.prepare(spec, refresh)
			}),
		connect: (id) =>
			Effect.suspend(() => {
				operations.push(`connect:${id}`)
				return Effect.map(capsule.connect(id), (spawner) =>
					ChildProcessSpawner.make((command) => {
						spawned.push({ capsule: id, words: words(command) })
						return spawner.spawn(command)
					}),
				)
			}),
		purge: (id) =>
			Effect.suspend(() => {
				operations.push(`purge:${id}`)
				return capsule.purge(id)
			}),
	})
	return { service, operations, spawned }
}

// An OpenAI-compatible model that answers a prompt containing `CAPSULE_CALL <tool> <json>` with
// that tool call and everything else with text, recording each tool result it receives.
const scriptedModel = Effect.gen(function* () {
	const toolResults: Array<string> = []
	const server = createServer((request, response) => {
		void respond(request, response, toolResults)
	})
	yield* Effect.acquireRelease(
		Effect.callback<void>((resume) => {
			server.listen(0, '127.0.0.1', () => resume(Effect.void))
		}),
		() => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
	)
	const address = server.address()
	const port = address !== null && typeof address === 'object' ? address.port : 0
	return { url: `http://127.0.0.1:${port}/v1`, toolResults }
})

const respond = async (
	request: IncomingMessage,
	response: ServerResponse,
	toolResults: Array<string>,
) => {
	let body = ''
	for await (const chunk of request) body += chunk
	const payload: {
		readonly messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>
		readonly tools?: ReadonlyArray<unknown>
	} = JSON.parse(body)
	const last = payload.messages.at(-1)
	const content = last?.content
	const text = Array.isArray(content)
		? content.map((part: { readonly text?: string }) => part.text ?? '').join('\n')
		: String(content ?? '')
	if (last?.role === 'tool') toolResults.push(text)
	const call =
		last?.role === 'user' && payload.tools?.length ? /CAPSULE_CALL (\w+) (.+)$/m.exec(text) : null

	const chunk = (delta: object, finish: string | null) =>
		`data: ${JSON.stringify({
			id: 'scripted',
			object: 'chat.completion.chunk',
			created: 0,
			model: 'scripted',
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`
	response.writeHead(200, { 'content-type': 'text/event-stream' })
	if (call) {
		const [, name, args] = call
		const toolCall = { index: 0, id: `call_${toolResults.length}`, type: 'function' }
		response.write(
			chunk(
				{ role: 'assistant', tool_calls: [{ ...toolCall, function: { name, arguments: args } }] },
				null,
			),
		)
		response.write(chunk({}, 'tool_calls'))
	} else {
		response.write(chunk({ role: 'assistant', content: 'done' }, null))
		response.write(chunk({}, 'stop'))
	}
	response.end('data: [DONE]\n\n')
}

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const base = input.runtime
		? yield* makeCapsule({ root: input.runtime.root, runtime: input.runtime.settings })
		: yield* controlledCapsule
	const capsule = recorded(base)
	const model = yield* scriptedModel
	const checkouts = new Map(input.checkouts.map((directory) => [Workspace.ID.create(), directory]))

	const driver = yield* CapsuleWorkspace.make({
		resolveSpec: (workspaceID) =>
			Effect.succeed({
				directory: checkouts.get(Workspace.ID.make(workspaceID)) ?? '',
				project: {},
			}),
	}).pipe(Effect.provideService(Capsule, capsule.service))
	const opencode = yield* OpenCode.create({
		config: {
			directory: input.config,
			project: false,
			claude: false,
			content: JSON.stringify({
				model: 'scripted/model',
				shell: '/bin/sh',
				snapshots: false,
				permissions: [{ action: '*', resource: '*', effect: 'allow' }],
				providers: {
					scripted: {
						package: '@opencode/ai/providers/openai-compatible',
						settings: { baseURL: model.url, apiKey: 'fixture' },
						models: { model: { capabilities: { tools: true } } },
					},
				},
			}),
		},
		models: { fetch: false },
		fs: { filewatcher: false },
		log: { level: 'warn', emit: (entry) => console.error(entry.level, entry.message) },
		workspaceProviders: { capsule: driver },
	})

	const visibility = `"$(test -e '${input.hostOnly}' && echo visible || echo hidden)"`
	// Search tools run the ripgrep that OpenCode resolves from its own PATH, so they only work when
	// that path is visible inside the workspace.
	const searches = [
		['grep', { pattern: 'GREP_NEEDLE' }],
		['glob', { pattern: '**/*.needle' }],
	] as const
	const toolCalls = (directory: string) => [
		['read', { path: path.join(directory, 'source.txt') }] as const,
		['read', { path: path.join(directory, 'escape') }] as const,
		[
			'shell',
			{
				command: `printf '%s:%s:%s' "$CAPSULE_FIXTURE" "$CAPSULE_ID" ${visibility} > agent-shell.txt`,
			},
		] as const,
		...(input.search ? searches : []),
	]

	// Both workspaces run at once, each through its own Capsule connection.
	const workspaces = yield* Effect.forEach(
		checkouts,
		([id, directory]) =>
			Effect.gen(function* () {
				const workspaceID = yield* opencode.workspace.create({ id, provider: 'capsule' })
				const session = yield* opencode.sessions.create({
					location: Location.Ref.make({ directory: AbsolutePath.make(directory), workspaceID }),
				})
				yield* opencode.sessions.shell({
					sessionID: session.id,
					command: `printf '%s' "$CAPSULE_ID" > user-shell.txt`,
				})
				for (const [tool, args] of toolCalls(directory)) {
					yield* opencode.sessions.prompt({
						sessionID: session.id,
						text: `CAPSULE_CALL ${tool} ${JSON.stringify(args)}`,
					})
					yield* opencode.experimental.session.wait({ sessionID: session.id })
				}
				const { binding } = yield* opencode.workspace.provision({ workspaceID })
				const output = (name: string) =>
					fs.readFileString(path.join(directory, name)).pipe(Effect.orElseSucceed(() => null))
				return {
					id: workspaceID,
					directory,
					sessionWorkspaceID: session.location.workspaceID,
					binding,
					userShell: yield* output('user-shell.txt'),
					agentShell: yield* output('agent-shell.txt'),
					pipeline: yield* pipelineEnvironment(driver, workspaceID, binding),
				}
			}),
		{ concurrency: 'unbounded' },
	)

	const [, destroyedID] = checkouts.keys()
	const destroyed = destroyedID
		? yield* opencode.workspace.destroy({ workspaceID: destroyedID })
		: null
	const unprovisionedID = yield* opencode.workspace.create({ provider: 'capsule' })
	yield* opencode.workspace.destroy({ workspaceID: unprovisionedID })
	const ids = [...checkouts.keys(), unprovisionedID]
	const phases = yield* Effect.forEach(ids, (id) =>
		Effect.map(base.inspect(id), (manifest) => [id, manifest?.phase ?? null] as const),
	)
	return {
		workspaces,
		destroyed,
		unprovisionedID,
		operations: capsule.operations,
		phases: Object.fromEntries(phases),
		spawned: capsule.spawned,
		toolResults: model.toolResults,
	}
})

// OpenCode never pipes through a workspace spawner itself, so the driver is exercised directly:
// each pipeline stage's overrides must extend the project environment.
const pipelineEnvironment = Effect.fn('pipelineEnvironment')(function* (
	driver: Effect.Success<ReturnType<typeof CapsuleWorkspace.make>>,
	workspaceID: Workspace.ID,
	binding: WorkspaceDriver.Binding,
) {
	const { spawner } = yield* driver.connect({
		workspaceID,
		binding,
		saveBinding: () => Effect.void,
	})
	const stage = (script: string) =>
		ChildProcess.make('sh', ['-c', script], { env: { LC_ALL: 'C' }, stdin: 'ignore' })
	const handle = yield* spawner.spawn(
		ChildProcess.pipeTo(
			stage(`printf '%s' "$CAPSULE_FIXTURE"`),
			stage(`cat; printf ':%s' "$CAPSULE_FIXTURE"`),
		),
	)
	return yield* Stream.mkString(Stream.decodeText(handle.stdout))
}, Effect.scoped)

const report = await Effect.runPromise(
	program.pipe(Effect.timeout('5 minutes'), Effect.scoped, Effect.provide(NodeServices.layer)),
)
process.stdout.write(`${JSON.stringify(report)}\n`)
