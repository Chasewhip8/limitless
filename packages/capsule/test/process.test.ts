import { NodeServices } from '@effect/platform-node'
import {
	Effect,
	FileSystem,
	Layer,
	Path,
	type PlatformError,
	Redacted,
	Schedule,
	type Scope,
	Sink,
	Stream,
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { describe, expect, it } from 'vitest'
import { makeSandboxSpawner, type SandboxConfig } from '../process'

const config: SandboxConfig = {
	bwrap: '/pinned/bwrap',
	shell: '/pinned/sh',
	env: '/pinned/env',
	basePath: '/gnu/bin',
	directory: '/capsules/a/home/checkout',
	home: '/capsules/a/home',
	temporary: '/capsules/a/tmp',
	runtime: '/capsules/a/run',
	readOnly: ['/nix/var/nix/daemon-socket', '/capsules/a/home/.gitconfig', '/nix/store'],
	environment: {
		PATH: '/project/bin',
		LANG: 'C.UTF-8',
		HOME: '/host/home',
		TOKEN: Redacted.make('project-secret'),
		UNSET: undefined,
	},
	reserved: { CAPSULE_ID: 'a', COMPOSE_PROJECT_NAME: 'capsule-a' },
}

const capsuleVariables = {
	HOME: '/capsules/a/home',
	TMPDIR: '/capsules/a/tmp',
	TMP: '/capsules/a/tmp',
	TEMP: '/capsules/a/tmp',
	TEMPDIR: '/capsules/a/tmp',
	XDG_RUNTIME_DIR: '/capsules/a/run',
	XDG_CONFIG_HOME: '/capsules/a/home/.config',
	XDG_CACHE_HOME: '/capsules/a/home/.cache',
	XDG_STATE_HOME: '/capsules/a/home/.local/state',
	CAPSULE_ID: 'a',
	COMPOSE_PROJECT_NAME: 'capsule-a',
}

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

const contractServices = Layer.mergeAll(
	FileSystem.layerNoop({ access: () => Effect.void }),
	Path.layer,
)

const spawned = (command: ChildProcess.Command, input: SandboxConfig = config) =>
	Effect.gen(function* () {
		const commands: Array<ChildProcess.Command> = []
		const spawner = yield* makeSandboxSpawner(input).pipe(
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recorder(commands)),
		)
		yield* Effect.scoped(spawner.spawn(command))
		return commands
	}).pipe(Effect.provide(contractServices), Effect.runPromise)

const rejection = (command: ChildProcess.Command, input: SandboxConfig = config) =>
	Effect.gen(function* () {
		const commands: Array<ChildProcess.Command> = []
		const spawner = yield* makeSandboxSpawner(input).pipe(
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recorder(commands)),
		)
		const error = yield* Effect.flip(Effect.scoped(spawner.spawn(command)))
		return { error, commands }
	}).pipe(Effect.provide(contractServices), Effect.runPromise)

const standard = (command: ChildProcess.Command | undefined) => {
	if (command?._tag !== 'StandardCommand') throw new Error('Expected a standard command')
	const separator = command.args.indexOf('--')
	return {
		command,
		sandbox: command.args.slice(0, separator),
		payload: command.args.slice(separator + 1),
	}
}

const option = (args: ReadonlyArray<unknown>, flag: string) => args[args.indexOf(flag) + 1]

describe('sandbox command contract', () => {
	it('preserves argv words, including redacted and template words, after the bwrap separator', async () => {
		const secret = Redacted.make('argument-secret')
		const words = ['two words', "quote'd", '$(touch injected)', '--', '*', '']
		const [command] = await spawned(
			ChildProcess.make`git commit -m ${words} ${secret}`.pipe(ChildProcess.setCwd('src')),
		)
		const { command: bwrap, sandbox, payload } = standard(command)

		expect(bwrap.command).toBe('/pinned/bwrap')
		expect(payload).toEqual(['git', 'commit', '-m', ...words, secret])
		expect(payload.at(-1)).toBe(secret)
		expect(bwrap.options.shell).toBeUndefined()
		expect(option(sandbox, '--chdir')).toBe('/capsules/a/home/checkout/src')
		expect(bwrap.options.cwd).toBe('/capsules/a/home/checkout/src')
	})

	it('runs shell scripts with the sandbox shell instead of a host shell', async () => {
		const [defaultShell] = await spawned(ChildProcess.make('echo "$HOME" | wc -c', { shell: true }))
		const [namedShell] = await spawned(
			ChildProcess.make('exit 3', { shell: '/nix/store/x/bin/bash' }),
		)

		expect(standard(defaultShell).payload).toEqual(['/bin/sh', '-c', 'echo "$HOME" | wc -c'])
		expect(standard(namedShell).payload).toEqual(['/nix/store/x/bin/bash', '-c', 'exit 3'])
		expect(standard(namedShell).command.options.shell).toBeUndefined()

		const { error, commands } = await rejection(
			ChildProcess.make('echo', ['unquoted'], { shell: true }),
		)
		expect(error.reason._tag).toBe('BadArgument')
		expect(commands).toEqual([])
	})

	it('builds the environment from the supplied base and keeps capsule variables last', async () => {
		const [inherited] = await spawned(ChildProcess.make('env'))
		const [extended] = await spawned(
			ChildProcess.make('env', {
				env: { LANG: 'C', EXTRA: 'value', TOKEN: undefined },
				extendEnv: true,
			}),
		)
		const [replaced] = await spawned(ChildProcess.make('env', { env: { ONLY: 'value' } }))
		const [searchPath] = await spawned(
			ChildProcess.make('env', { env: { PATH: '/override/bin:/gnu/bin' }, extendEnv: true }),
		)

		expect(standard(inherited).command.options).toMatchObject({ extendEnv: false })
		expect(standard(inherited).command.options.env).toEqual({
			LANG: 'C.UTF-8',
			TOKEN: config.environment.TOKEN,
			PATH: '/gnu/bin:/project/bin',
			...capsuleVariables,
		})
		expect(standard(extended).command.options.env).toEqual({
			LANG: 'C',
			EXTRA: 'value',
			PATH: '/gnu/bin:/project/bin',
			...capsuleVariables,
		})
		expect(standard(replaced).command.options.env).toEqual({
			ONLY: 'value',
			PATH: '/gnu/bin',
			...capsuleVariables,
		})
		expect(standard(searchPath).command.options.env?.PATH).toBe('/gnu/bin:/override/bin')
		expect(JSON.stringify(standard(inherited).command.args)).not.toContain('project-secret')

		for (const name of ['HOME', 'TMPDIR', 'CAPSULE_ID']) {
			const { error, commands } = await rejection(
				ChildProcess.make('env', { env: { [name]: '/elsewhere' }, extendEnv: true }),
			)
			expect(error.reason._tag).toBe('BadArgument')
			expect(commands).toEqual([])
		}
	})

	it('maps working directories through mounts and rejects unexposed ones', async () => {
		const [temporary] = await spawned(ChildProcess.make('pwd', { cwd: '/tmp/build' }))
		expect(option(standard(temporary).sandbox, '--chdir')).toBe('/tmp/build')
		expect(standard(temporary).command.options.cwd).toBe('/capsules/a/tmp/build')

		for (const cwd of ['/etc', '/capsules/a', '../../other']) {
			const { error, commands } = await rejection(ChildProcess.make('pwd', { cwd }))
			expect(error.reason._tag).toBe('BadArgument')
			expect(commands).toEqual([])
		}
	})

	it('mounts parents before nested paths with the capsule layout', async () => {
		const [command] = await spawned(ChildProcess.make('true'))
		const { sandbox } = standard(command)
		const mounts: Array<string> = []
		for (let index = 0; index < sandbox.length; index++) {
			const flag = sandbox[index]
			if (flag === '--bind' || flag === '--ro-bind') {
				mounts.push(`${flag} ${sandbox[index + 1]} ${sandbox[index + 2]}`)
				index += 2
			}
		}

		expect(sandbox).toEqual(expect.arrayContaining(['--unshare-pid', '--die-with-parent']))
		expect(sandbox).not.toContain('--unshare-net')
		expect(mounts).toEqual([
			'--bind /capsules/a/tmp /tmp',
			'--ro-bind /nix/store /nix/store',
			'--ro-bind /pinned/sh /bin/sh',
			'--ro-bind /pinned/env /usr/bin/env',
			'--bind /capsules/a/home /capsules/a/home',
			'--bind /capsules/a/tmp /capsules/a/tmp',
			'--bind /capsules/a/run /capsules/a/run',
			'--bind /capsules/a/home/checkout /capsules/a/home/checkout',
			'--ro-bind /nix/var/nix/daemon-socket /nix/var/nix/daemon-socket',
			'--ro-bind /capsules/a/home/.gitconfig /capsules/a/home/.gitconfig',
		])
	})

	it('sandboxes every pipeline stage and keeps descriptors and process options', async () => {
		const input = Stream.make(new TextEncoder().encode('input'))
		const left = ChildProcess.make('producer', [], {
			stdin: input,
			stderr: 'inherit',
			detached: false,
			additionalFds: { fd3: { type: 'output' } },
			killSignal: 'SIGINT',
			forceKillAfter: '1 second',
		})
		const right = ChildProcess.make('consumer', { cwd: '/tmp' })
		const [command] = await spawned(
			left.pipe(ChildProcess.pipeTo(right, { from: 'fd3', to: 'fd4' })),
		)

		if (command?._tag !== 'PipedCommand') throw new Error('Expected a piped command')
		expect(command.options).toEqual({ from: 'fd3', to: 'fd4' })
		const producer = standard(command.left)
		const consumer = standard(command.right)
		expect(producer.payload).toEqual(['producer'])
		expect(producer.command.options).toMatchObject({
			stdin: input,
			stderr: 'inherit',
			detached: false,
			additionalFds: left.options.additionalFds,
			killSignal: 'SIGINT',
			forceKillAfter: '1 second',
		})
		expect(consumer.payload).toEqual(['consumer'])
		expect(consumer.command.options.cwd).toBe('/capsules/a/tmp')
	})

	it('rejects options it cannot carry into the sandbox', async () => {
		const command = ChildProcess.make('true', { argv0: 'other' } as ChildProcess.CommandOptions)
		const { error, commands } = await rejection(command)
		expect(error.reason._tag).toBe('BadArgument')
		expect(commands).toEqual([])
	})

	it('rejects invalid layouts before spawning anything', async () => {
		const invalid: ReadonlyArray<SandboxConfig> = [
			{ ...config, home: 'relative/home' },
			{ ...config, directory: '/capsules/a/home/../checkout' },
			{ ...config, readOnly: ['/tmp'] },
			{ ...config, reserved: { HOME: '/other' } },
		]
		for (const input of invalid) {
			const error = await makeSandboxSpawner(input).pipe(
				Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recorder([])),
				Effect.provide(contractServices),
				Effect.flip,
				Effect.runPromise,
			)
			expect(error.reason._tag).toBe('BadArgument')
		}

		const missing = await makeSandboxSpawner(config).pipe(
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recorder([])),
			Effect.provide(Layer.mergeAll(FileSystem.layerNoop({}), Path.layer)),
			Effect.flip,
			Effect.runPromise,
		)
		expect(missing.reason._tag).toBe('NotFound')
	})
})

const bwrap = process.env.CAPSULE_TEST_BWRAP
const shell = process.env.CAPSULE_TEST_SHELL
const coreutils = process.env.CAPSULE_TEST_COREUTILS

const realCapsule = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = yield* fs.makeTempDirectoryScoped({ prefix: 'capsule-process-' })
	const [directory, home, temporary, runtime, shared] = [
		'checkout',
		'home',
		'tmp',
		'run',
		'shared',
	].map((name) => path.join(root, name)) as [string, string, string, string, string]
	for (const location of [directory, home, temporary, runtime, shared, path.join(directory, 'sub')])
		yield* fs.makeDirectory(location)
	yield* fs.writeFileString(path.join(shared, 'file'), 'original')
	const input: SandboxConfig = {
		bwrap: bwrap ?? '',
		shell: shell ?? '',
		env: path.join(coreutils ?? '', 'env'),
		basePath: coreutils ?? '',
		directory,
		home,
		temporary,
		runtime,
		readOnly: [shared],
		environment: { LANG: 'C', PROJECT: 'value' },
		reserved: { CAPSULE_ID: 'real' },
	}
	const spawner = yield* makeSandboxSpawner(input)
	return { input, spawner, shared }
})

const running = (token: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const entries = yield* fs.readDirectory('/proc')
		const commandLines = yield* Effect.forEach(
			entries.filter((entry) => /^\d+$/.test(entry)),
			(pid) => fs.readFileString(`/proc/${pid}/cmdline`).pipe(Effect.orElseSucceed(() => '')),
		)
		return commandLines.some((commandLine) => commandLine.includes(token))
	})

const eventually = (
	check: Effect.Effect<boolean, PlatformError.PlatformError, FileSystem.FileSystem>,
) =>
	check.pipe(
		Effect.filterOrFail((done) => done),
		Effect.retry({ schedule: Schedule.spaced('20 millis'), times: 100 }),
	)

const runReal = <A, E>(
	program: Effect.Effect<
		A,
		E,
		FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
	>,
) => Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

describe.skipIf(!bwrap || !shell || !coreutils)('sandbox processes', () => {
	it('preserves argv, cwd, and the curated environment in a real sandbox', () =>
		runReal(
			Effect.gen(function* () {
				const { input, spawner } = yield* realCapsule
				const words = ['plain', 'two words', "quote'd", '$(touch injected)', '*', '', 'line\nbreak']
				const printed = yield* spawner.string(
					ChildProcess.make('printf', ['%s\\0', ...words, Redacted.make('secret')]),
				)
				expect(printed.split('\0').slice(0, -1)).toEqual([...words, 'secret'])

				expect(yield* spawner.string(ChildProcess.make('pwd'))).toBe(`${input.directory}\n`)
				expect(yield* spawner.string(ChildProcess.make('pwd', { cwd: 'sub' }))).toBe(
					`${input.directory}/sub\n`,
				)

				const printedEnvironment = yield* spawner.string(
					ChildProcess.make('/usr/bin/env', ['-0'], { env: { EXTRA: 'x' }, extendEnv: true }),
				)
				const environment = Object.fromEntries(
					printedEnvironment
						.split('\0')
						.slice(0, -1)
						.map((entry) => [
							entry.slice(0, entry.indexOf('=')),
							entry.slice(entry.indexOf('=') + 1),
						]),
				)
				expect(environment).toEqual({
					LANG: 'C',
					PROJECT: 'value',
					EXTRA: 'x',
					PATH: input.basePath,
					CAPSULE_ID: 'real',
					HOME: input.home,
					TMPDIR: input.temporary,
					TMP: input.temporary,
					TEMP: input.temporary,
					TEMPDIR: input.temporary,
					XDG_RUNTIME_DIR: input.runtime,
					XDG_CONFIG_HOME: `${input.home}/.config`,
					XDG_CACHE_HOME: `${input.home}/.cache`,
					XDG_STATE_HOME: `${input.home}/.local/state`,
					PWD: input.directory,
				})

				const fs = yield* FileSystem.FileSystem
				const projectBin = `${input.directory}/bin`
				yield* fs.makeDirectory(projectBin)
				for (const tool of ['cat', 'project-tool']) {
					yield* fs.writeFileString(`${projectBin}/${tool}`, '#!/bin/sh\n')
					yield* fs.chmod(`${projectBin}/${tool}`, 0o755)
				}
				const resolved = yield* spawner.string(
					ChildProcess.make('command -v cat; command -v project-tool', {
						shell: true,
						env: { PATH: projectBin },
						extendEnv: true,
					}),
				)
				expect(resolved).toBe(`${input.basePath}/cat\n${projectBin}/project-tool\n`)
			}),
		))

	it('binds the capsule temporary directory at /tmp and keeps selected mounts read-only', () =>
		runReal(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const { input, spawner, shared } = yield* realCapsule
				const written = yield* spawner.exitCode(
					ChildProcess.make('echo inside > /tmp/marker', { shell: true, cwd: '/tmp' }),
				)
				expect(written).toBe(0)
				expect(yield* fs.readFileString(`${input.temporary}/marker`)).toBe('inside\n')

				const denied = yield* spawner.exitCode(
					ChildProcess.make(`echo changed > ${shared}/file`, { shell: true }),
				)
				expect(denied).not.toBe(0)
				expect(yield* fs.readFileString(`${shared}/file`)).toBe('original')
			}),
		))

	it('streams pipelines through stdio and additional descriptors', () =>
		runReal(
			Effect.gen(function* () {
				const { spawner } = yield* realCapsule
				const fromDescriptor = yield* spawner.string(
					ChildProcess.make('echo out; echo side >&3', {
						shell: true,
						additionalFds: { fd3: { type: 'output' } },
					}).pipe(ChildProcess.pipeTo(ChildProcess.make('tr', ['a-z', 'A-Z']), { from: 'fd3' })),
				)
				expect(fromDescriptor).toBe('SIDE\n')

				const toDescriptor = yield* spawner.string(
					ChildProcess.make('printf', ['hello']).pipe(
						ChildProcess.pipeTo(ChildProcess.make('tr a-z A-Z <&3', { shell: true }), {
							to: 'fd3',
						}),
					),
				)
				expect(toDescriptor).toBe('HELLO')

				const handle = yield* spawner.spawn(
					ChildProcess.make('echo five >&5', {
						shell: true,
						stdin: Stream.make(new TextEncoder().encode('ignored')),
						additionalFds: { fd5: { type: 'output' } },
					}),
				)
				const five = yield* Stream.mkString(Stream.decodeText(handle.getOutputFd(5)))
				expect(five).toBe('five\n')
				expect(yield* handle.exitCode).toBe(0)
			}),
		))

	it('reports exit codes and external signals like the host spawner', () =>
		runReal(
			Effect.gen(function* () {
				const { spawner } = yield* realCapsule
				expect(yield* spawner.exitCode(ChildProcess.make('exit 7', { shell: true }))).toBe(7)

				const handle = yield* spawner.spawn(ChildProcess.make('sleep', ['30']))
				yield* handle.kill({ killSignal: 'SIGTERM' })
				const error = yield* Effect.flip(handle.exitCode)
				expect(String(error.cause)).toContain("signal: 'SIGTERM'")
			}),
		))

	it('ends background descendants with their command and with a closed scope', () =>
		runReal(
			Effect.gen(function* () {
				const { spawner } = yield* realCapsule
				const finished = `299.${Date.now()}1`
				const handle = yield* spawner.spawn(
					ChildProcess.make(`sleep ${finished} & echo started`, { shell: true }),
				)
				expect(yield* handle.exitCode).toBe(0)
				yield* eventually(Effect.map(running(finished), (alive) => !alive))

				const interrupted = `299.${Date.now()}2`
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* spawner.spawn(
							ChildProcess.make(`sleep ${interrupted} & sleep ${interrupted}`, { shell: true }),
						)
						yield* eventually(running(interrupted))
					}),
				)
				yield* eventually(Effect.map(running(interrupted), (alive) => !alive))
			}),
		))
})
