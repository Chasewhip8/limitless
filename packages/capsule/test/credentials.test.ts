import { NodeServices } from '@effect/platform-node'
import {
	ConfigProvider,
	Effect,
	FileSystem,
	Layer,
	Path,
	Redacted,
	type Scope,
	Sink,
	Stream,
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { describe, expect, it } from 'vitest'
import {
	applyCredentials,
	type CredentialEnvironment,
	type CredentialsOptions,
	makeCredentials,
} from '../src/credentials'
import { makeSandboxSpawner, type SandboxConfig } from '../src/runtime/sandbox'

// Synthetic values only: tests never read the hosting process environment or user accounts.
const firstToken = 'ghp_syntheticCapsuleTokenOne'
const secondToken = 'ghp_syntheticCapsuleTokenTwo'
const hostPath = process.env.PATH ?? ''
const helperKey = 'credential.https://github.com.helper'
const noEnvironment = ConfigProvider.fromEnv({ env: {} })

const fakeGh = `#!/bin/sh
[ "$1 $2 $3" = "auth git-credential get" ] || exit 2
input=$(cat)
case "$input" in *host=github.com*) ;; *) exit 3 ;; esac
[ -n "$GH_TOKEN" ] || exit 1
printf 'protocol=https\\nhost=github.com\\nusername=x-access-token\\npassword=%s\\n' "$GH_TOKEN"
`

const run = <A, E>(
	effect: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices>,
	provider = noEnvironment,
) =>
	Effect.runPromise(
		effect.pipe(
			Effect.scoped,
			Effect.provideService(ConfigProvider.ConfigProvider, provider),
			Effect.provide(NodeServices.layer),
		),
	)

const makeFixture = Effect.fn('makeFixture')(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	yield* fs.makeDirectory('/tmp/opencode', { recursive: true })
	const base = yield* fs.realPath(
		yield* fs.makeTempDirectoryScoped({
			directory: '/tmp/opencode',
			prefix: 'capsule-credentials-',
		}),
	)
	const gh = path.join(base, 'gh')
	yield* fs.writeFileString(gh, fakeGh)
	yield* fs.chmod(gh, 0o755)
	yield* fs.makeDirectory(path.join(base, 'home'))
	return { base, gh, home: path.join(base, 'home'), tokenFile: path.join(base, 'token') }
})

const recorder = (commands: Array<ChildProcess.Command>) =>
	ChildProcessSpawner.make((command) =>
		Effect.sync(() => {
			commands.push(command)
			return ChildProcessSpawner.makeHandle({
				pid: ChildProcessSpawner.ProcessId(1),
				exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
				isRunning: Effect.succeed(false),
				kill: () => Effect.void,
				stdin: Sink.drain,
				stdout: Stream.empty,
				stderr: Stream.empty,
				all: Stream.empty,
				getInputFd: () => Sink.drain,
				getOutputFd: () => Stream.empty,
				unref: Effect.succeed(Effect.void),
			})
		}),
	)

const standard = (command: ChildProcess.Command | undefined) => {
	if (command?._tag !== 'StandardCommand') throw new Error('Expected a standard command')
	return command
}

const reveal = (value: unknown) => (Redacted.isRedacted(value) ? Redacted.value(value) : value)

const output = Effect.fn('output')(function* (
	spawner: ChildProcessSpawner.ChildProcessSpawner['Service'],
	command: ChildProcess.Command,
) {
	const handle = yield* spawner.spawn(command)
	const [stdout, stderr, exitCode] = yield* Effect.all(
		[
			Stream.mkString(Stream.decodeText(handle.stdout)),
			Stream.mkString(Stream.decodeText(handle.stderr)),
			handle.exitCode,
		],
		{ concurrency: 'unbounded' },
	)
	return { stdout, stderr, exitCode }
}, Effect.scoped)

const isolatedGit = (home: string) => ({
	PATH: hostPath,
	HOME: home,
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: '/dev/null',
})

const credentialFill = (home: string) =>
	ChildProcess.make('printf', ['protocol=https\\nhost=github.com\\n\\n'], {
		env: isolatedGit(home),
	}).pipe(
		ChildProcess.pipeTo(
			ChildProcess.make('git', ['credential', 'fill'], {
				env: {
					...isolatedGit(home),
					// A project helper that the authoritative GitHub entries must replace.
					GIT_CONFIG_COUNT: '1',
					GIT_CONFIG_KEY_0: 'credential.helper',
					GIT_CONFIG_VALUE_0: '!f() { echo password=project-helper; }; f',
				},
			}),
		),
	)

describe('credential options', () => {
	it('rejects ambiguous or unsafe host configuration before any execution', async () => {
		const reasons = await run(
			Effect.gen(function* () {
				const { gh, tokenFile } = yield* makeFixture()
				const invalid: ReadonlyArray<[typeof CredentialsOptions.Encoded, string]> = [
					[{ github: { tokenFile, tokenEnv: 'TOKEN' } }, gh],
					[{ github: { tokenFile: 'relative/token' } }, gh],
					[{ github: { tokenFile: `${tokenFile}/../token` } }, gh],
					[{ github: { tokenEnv: 'not a name' } }, gh],
					[{ github: {} }, 'gh'],
					[{ github: {} }, `${gh}-missing`],
					[{ identity: { name: 'Agent\nInjected', email: 'agent@example.invalid' } }, gh],
					[{ identity: { name: 'Agent\u0085Injected', email: 'agent@example.invalid' } }, gh],
					[{ identity: { name: 'Agent', email: '<agent@example.invalid>' } }, gh],
				]
				return yield* Effect.forEach(invalid, ([options, executable]) =>
					Effect.flip(makeCredentials(options, executable)).pipe(
						Effect.map((error) => error.reason),
					),
				)
			}),
		)
		expect(reasons).toEqual(Array(9).fill('invalid_options'))
	})

	it('accepts identities beyond ASCII', async () => {
		const credentials = await run(
			Effect.gen(function* () {
				const { gh } = yield* makeFixture()
				const { environment } = yield* makeCredentials(
					{ identity: { name: 'Zoë Agent', email: 'zoë@example.invalid' } },
					gh,
				)
				return yield* environment
			}),
		)
		expect(credentials.variables).toMatchObject({ GIT_AUTHOR_NAME: 'Zoë Agent' })
	})
})

describe('credential sources', () => {
	it('rereads a rotated token file for each execution through one long-lived spawner', async () => {
		const commands: Array<ChildProcess.Command> = []
		await run(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const { gh, tokenFile } = yield* makeFixture()
				const credentials = yield* makeCredentials({ github: { tokenFile } }, gh)
				const spawner = credentials.decorate(recorder(commands))
				const command = ChildProcess.make('gh', ['pr', 'list'])

				yield* fs.writeFileString(tokenFile, `${firstToken}\n`)
				yield* Effect.scoped(spawner.spawn(command))
				yield* fs.writeFileString(tokenFile, secondToken)
				yield* Effect.scoped(spawner.spawn(command))
			}),
		)
		const tokens = commands.map((command) => standard(command).options.env?.GH_TOKEN)
		expect(tokens.every(Redacted.isRedacted)).toBe(true)
		expect(tokens.map(reveal)).toEqual([firstToken, secondToken])
	})

	it('reports unusable token files without exposing their contents', async () => {
		const failures = await run(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const { gh, tokenFile } = yield* makeFixture()
				const credentials = yield* makeCredentials({ github: { tokenFile } }, gh)
				const spawner = credentials.decorate(recorder([]))
				const attempt = Effect.gen(function* () {
					const direct = yield* Effect.flip(credentials.environment)
					const spawned = yield* Effect.flip(
						Effect.scoped(spawner.spawn(ChildProcess.make('git', ['fetch']))),
					)
					return { direct, spawned }
				})

				const missing = yield* attempt
				yield* fs.writeFileString(tokenFile, '\n')
				const empty = yield* attempt
				yield* fs.writeFileString(tokenFile, `${firstToken} ${secondToken}\n`)
				const malformed = yield* attempt
				return { missing, empty, malformed }
			}),
		)
		expect(failures.missing.direct.reason).toBe('token_unreadable')
		expect(failures.empty.direct.reason).toBe('token_invalid')
		expect(failures.malformed.direct.reason).toBe('token_invalid')
		expect(failures.malformed.spawned.reason._tag).toBe('InvalidData')
		for (const failure of Object.values(failures)) {
			const diagnostics = [
				String(failure.direct),
				JSON.stringify(failure.direct),
				String(failure.spawned),
				JSON.stringify(failure.spawned),
				failure.spawned.message,
			].join('\n')
			expect(diagnostics).not.toContain(firstToken)
			expect(diagnostics).not.toContain(secondToken)
		}
	})

	it('reads the configured variable, falls back to GH_TOKEN then GITHUB_TOKEN, and permits absence', async () => {
		const resolve = (
			options: typeof CredentialsOptions.Encoded,
			env: Record<string, string>,
		): Promise<CredentialEnvironment> =>
			run(
				Effect.gen(function* () {
					const { gh } = yield* makeFixture()
					const credentials = yield* makeCredentials(options, gh)
					return yield* credentials.environment
				}),
				ConfigProvider.fromEnv({ env }),
			)
		const token = (credentials: CredentialEnvironment) => reveal(credentials.variables.GH_TOKEN)

		const configured = await resolve(
			{ github: { tokenEnv: 'CAPSULE_GITHUB_TOKEN' } },
			{ CAPSULE_GITHUB_TOKEN: firstToken, GH_TOKEN: secondToken },
		)
		const preferred = await resolve(
			{ github: {} },
			{ GH_TOKEN: firstToken, GITHUB_TOKEN: secondToken },
		)
		const fallback = await resolve({ github: {} }, { GITHUB_TOKEN: secondToken })
		const absent = await resolve({ github: { tokenEnv: 'CAPSULE_GITHUB_TOKEN' } }, {})
		const disabled = await resolve({}, { GH_TOKEN: firstToken })

		expect(token(configured)).toBe(firstToken)
		expect(token(preferred)).toBe(firstToken)
		expect(token(fallback)).toBe(secondToken)
		expect(Redacted.isRedacted(fallback.variables.GH_TOKEN)).toBe(true)
		expect(fallback.variables).toMatchObject({ GITHUB_TOKEN: undefined })
		expect(token(absent)).toBeUndefined()
		expect(absent.gitConfig.map(([key]) => key)).toEqual([helperKey, helperKey])
		expect(token(disabled)).toBeUndefined()
		expect(disabled.gitConfig).toEqual([])
		expect(disabled.variables).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' })
	})
})

describe('credential environment', () => {
	const credentials: CredentialEnvironment = {
		variables: { GH_TOKEN: Redacted.make(firstToken), GITHUB_TOKEN: undefined },
		gitConfig: [
			[helperKey, ''],
			[helperKey, "!'/nix/store/gh' auth git-credential"],
		],
	}

	it('appends authoritative Git entries after well-formed project entries', () => {
		const applied = applyCredentials(
			{
				GITHUB_TOKEN: 'project-token',
				GIT_CONFIG_COUNT: Redacted.make('1'),
				GIT_CONFIG_KEY_0: Redacted.make('core.autocrlf'),
				GIT_CONFIG_VALUE_0: Redacted.make('false'),
			},
			credentials,
		)
		expect(Object.keys(applied).sort()).toEqual([
			'GH_TOKEN',
			'GIT_CONFIG_COUNT',
			'GIT_CONFIG_KEY_0',
			'GIT_CONFIG_KEY_1',
			'GIT_CONFIG_KEY_2',
			'GIT_CONFIG_VALUE_0',
			'GIT_CONFIG_VALUE_1',
			'GIT_CONFIG_VALUE_2',
		])
		expect(applied).toMatchObject({
			GIT_CONFIG_COUNT: '3',
			GIT_CONFIG_KEY_1: helperKey,
			GIT_CONFIG_VALUE_1: '',
			GIT_CONFIG_KEY_2: helperKey,
			GIT_CONFIG_VALUE_2: "!'/nix/store/gh' auth git-credential",
		})
		expect(reveal(applied.GIT_CONFIG_KEY_0)).toBe('core.autocrlf')
	})

	it('numbers entries deterministically after malformed or incomplete project entries', () => {
		const bogus = applyCredentials(
			{ GIT_CONFIG_COUNT: 'two', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' },
			credentials,
		)
		const incomplete = applyCredentials(
			{
				GIT_CONFIG_COUNT: '4',
				GIT_CONFIG_KEY_0: 'a.b',
				GIT_CONFIG_VALUE_0: 'c',
				GIT_CONFIG_KEY_1: 'd.e',
				GIT_CONFIG_KEY_3: 'f.g',
				GIT_CONFIG_VALUE_3: 'h',
			},
			credentials,
		)
		expect(bogus).toMatchObject({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: helperKey })
		expect(incomplete).toMatchObject({
			GIT_CONFIG_COUNT: '3',
			GIT_CONFIG_KEY_0: 'a.b',
			GIT_CONFIG_KEY_1: helperKey,
			GIT_CONFIG_VALUE_1: '',
			GIT_CONFIG_KEY_2: helperKey,
		})
		expect(incomplete).not.toHaveProperty('GIT_CONFIG_KEY_3')
		expect(incomplete).not.toHaveProperty('GIT_CONFIG_VALUE_3')
	})
})

describe('decorated commands', () => {
	const project = {
		PATH: Redacted.make('/project/bin'),
		GITHUB_TOKEN: Redacted.make('project-token'),
		GIT_CONFIG_COUNT: Redacted.make('1'),
		GIT_CONFIG_KEY_0: Redacted.make('core.autocrlf'),
		GIT_CONFIG_VALUE_0: Redacted.make('false'),
	}

	const decorated = (command: ChildProcess.Command) => {
		const commands: Array<ChildProcess.Command> = []
		return run(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const { gh, tokenFile } = yield* makeFixture()
				yield* fs.writeFileString(tokenFile, firstToken)
				const credentials = yield* makeCredentials(
					{
						github: { tokenFile },
						identity: { name: 'Capsule Agent', email: 'agent@example.invalid' },
					},
					gh,
				)
				yield* Effect.scoped(credentials.decorate(recorder(commands), project).spawn(command))
				return { commands, gh }
			}),
		)
	}

	it('keeps inheriting commands inheriting and numbers Git entries after the inherited ones', async () => {
		const { commands, gh } = await decorated(ChildProcess.make('git', ['fetch']))
		const { options } = standard(commands[0])
		expect(options.extendEnv).toBe(true)
		expect(options.env).not.toHaveProperty('PATH')
		expect(options.env).toMatchObject({
			GITHUB_TOKEN: undefined,
			GIT_CONFIG_COUNT: '3',
			GIT_CONFIG_KEY_1: helperKey,
			GIT_CONFIG_VALUE_1: '',
			GIT_CONFIG_KEY_2: helperKey,
			GIT_CONFIG_VALUE_2: `!'${gh}' auth git-credential`,
			GIT_TERMINAL_PROMPT: '0',
			GH_PROMPT_DISABLED: '1',
			GIT_AUTHOR_NAME: 'Capsule Agent',
			GIT_AUTHOR_EMAIL: 'agent@example.invalid',
			GIT_COMMITTER_NAME: 'Capsule Agent',
			GIT_COMMITTER_EMAIL: 'agent@example.invalid',
		})
		expect(reveal(options.env?.GH_TOKEN)).toBe(firstToken)
	})

	it('keeps replacing commands replacing, overrides their credential variables, and keeps argv clean', async () => {
		const { commands } = await decorated(
			ChildProcess.make('git', ['push', 'origin'], {
				env: { PATH: '/bin', GH_TOKEN: 'command-token', GIT_AUTHOR_NAME: 'Other' },
			}),
		)
		const command = standard(commands[0])
		expect(command.options.extendEnv).toBeUndefined()
		expect(command.options.env).toMatchObject({
			PATH: '/bin',
			GIT_CONFIG_COUNT: '2',
			GIT_CONFIG_KEY_0: helperKey,
			GIT_AUTHOR_NAME: 'Capsule Agent',
		})
		expect(reveal(command.options.env?.GH_TOKEN)).toBe(firstToken)
		expect(command.args).toEqual(['push', 'origin'])
		expect(JSON.stringify(command)).not.toContain(firstToken)
	})

	it('applies the same execution credentials to every pipeline stage', async () => {
		const { commands } = await decorated(
			ChildProcess.make('git', ['ls-remote']).pipe(
				ChildProcess.pipeTo(ChildProcess.make('head', ['-1'], { env: { PATH: '/bin' } })),
			),
		)
		const pipeline = commands[0]
		if (pipeline?._tag !== 'PipedCommand') throw new Error('Expected a pipeline')
		const left = standard(pipeline.left)
		const right = standard(pipeline.right)
		expect(left.options.extendEnv).toBe(true)
		expect(right.options.extendEnv).toBeUndefined()
		expect([left, right].map((stage) => reveal(stage.options.env?.GH_TOKEN))).toEqual([
			firstToken,
			firstToken,
		])
		expect(left.options.env?.GIT_CONFIG_COUNT).toBe('3')
		expect(right.options.env?.GIT_CONFIG_COUNT).toBe('2')
	})

	it('reaches sandboxed commands after the cached environment without inheriting the host', async () => {
		const sandbox: SandboxConfig = {
			bwrap: '/pinned/bwrap',
			shell: '/pinned/sh',
			env: '/pinned/env',
			basePath: '/gnu/bin',
			directory: '/capsules/a/checkout',
			home: '/capsules/a/home',
			temporary: '/capsules/a/tmp',
			runtime: '/capsules/a/run',
			readOnly: [],
			environment: project,
			reserved: { CAPSULE_ID: 'a' },
		}
		const commands: Array<ChildProcess.Command> = []
		await run(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const { gh, tokenFile } = yield* makeFixture()
				yield* fs.writeFileString(tokenFile, firstToken)
				const credentials = yield* makeCredentials({ github: { tokenFile } }, gh)
				const spawner = yield* makeSandboxSpawner(sandbox).pipe(
					Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recorder(commands)),
					Effect.provide(
						Layer.mergeAll(FileSystem.layerNoop({ access: () => Effect.void }), Path.layer),
					),
				)
				const decorated = credentials.decorate(spawner, sandbox.environment)
				yield* Effect.scoped(decorated.spawn(ChildProcess.make('git', ['fetch'])))
				yield* Effect.scoped(
					decorated.spawn(ChildProcess.make('git', ['fetch'], { env: { PATH: '/bin' } })),
				)
			}),
		)
		const [inheriting, replacing] = commands.map((command) => standard(command).options)
		expect(inheriting?.extendEnv).toBe(false)
		expect(Object.keys(inheriting?.env ?? {})).not.toContain('GITHUB_TOKEN')
		expect(inheriting?.env).toMatchObject({
			PATH: '/gnu/bin:/project/bin',
			GIT_CONFIG_COUNT: '3',
			GIT_CONFIG_KEY_2: helperKey,
			HOME: '/capsules/a/home',
		})
		expect(reveal(inheriting?.env?.GIT_CONFIG_KEY_0)).toBe('core.autocrlf')
		expect(reveal(inheriting?.env?.GH_TOKEN)).toBe(firstToken)
		expect(replacing?.env).toMatchObject({
			PATH: '/gnu/bin:/bin',
			GIT_CONFIG_COUNT: '2',
			GIT_CONFIG_KEY_0: helperKey,
		})
		expect(Object.keys(replacing?.env ?? {})).not.toContain('USER')
	})
})

describe('Git credential helper', () => {
	it('authenticates ordinary Git through the pinned CLI with the current token', async () => {
		const results = await run(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const host = yield* ChildProcessSpawner.ChildProcessSpawner
				const { gh, home, tokenFile } = yield* makeFixture()
				const credentials = yield* makeCredentials(
					{
						github: { tokenFile },
						identity: { name: 'Capsule Agent', email: 'agent@example.invalid' },
					},
					gh,
				)
				const spawner = credentials.decorate(host)

				yield* fs.writeFileString(tokenFile, `${firstToken}\n`)
				const first = yield* output(spawner, credentialFill(home))
				yield* fs.writeFileString(tokenFile, secondToken)
				const second = yield* output(spawner, credentialFill(home))
				const identity = yield* output(
					spawner,
					ChildProcess.make('git', ['var', 'GIT_COMMITTER_IDENT'], { env: isolatedGit(home) }),
				)
				return { first, second, identity }
			}),
		)
		expect(results.first.exitCode).toBe(0)
		expect(results.first.stdout).toContain('username=x-access-token')
		expect(results.first.stdout).toContain(`password=${firstToken}`)
		expect(results.first.stdout).not.toContain('project-helper')
		expect(results.second.stdout).toContain(`password=${secondToken}`)
		expect(results.identity.stdout).toMatch(/^Capsule Agent <agent@example\.invalid> /)
	})

	it('fails private operations without a token instead of prompting', async () => {
		const result = await run(
			Effect.gen(function* () {
				const host = yield* ChildProcessSpawner.ChildProcessSpawner
				const { gh, home } = yield* makeFixture()
				const credentials = yield* makeCredentials({ github: {} }, gh)
				return yield* output(credentials.decorate(host), credentialFill(home))
			}),
		)
		expect(result.exitCode).not.toBe(0)
		expect(result.stdout).not.toContain('password=')
		expect(result.stderr).toContain('terminal prompts disabled')
	})
})
