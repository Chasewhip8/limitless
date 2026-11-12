import { Effect, FileSystem, Path, PlatformError, Redacted } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

type EnvironmentValue = string | Redacted.Redacted<string>

/**
 * Paths must be absolute and normalized. The executables, writable directories, and read-only
 * mounts must exist when the spawner is made. Commands get their own mount and PID namespaces and
 * share the host network; this is hygiene isolation, not a boundary against hostile code.
 */
export interface SandboxConfig {
	readonly bwrap: string
	/** Mounted at `/bin/sh`, which also runs `shell: true` commands. */
	readonly shell: string
	/** Mounted at `/usr/bin/env`. */
	readonly env: string
	readonly directory: string
	readonly home: string
	/** Visible at its own path and as the sandbox's `/tmp`. */
	readonly temporary: string
	readonly runtime: string
	/**
	 * Host files, directories, or sockets mounted read-only at the same path, such as Nix daemon
	 * sockets. `/nix/store` is always mounted.
	 */
	readonly readOnly: ReadonlyArray<string>
	/** Borrowed writable resources, such as the metadata directories of a linked Git worktree. */
	readonly readWrite?: ReadonlyArray<string>
	/**
	 * The complete environment a command inherits; the host process environment is never used.
	 * Undefined values are absent.
	 */
	readonly environment: Readonly<Record<string, EnvironmentValue | undefined>>
	/** Capsule variables, such as identity or Compose settings, that commands cannot override. */
	readonly reserved: Readonly<Record<string, string>>
	/**
	 * Pinned search path entries that lead every command's `PATH`, ahead of project and command
	 * entries, so baseline utilities resolve first. Leave language runtimes to the project.
	 */
	readonly basePath: string
}

interface Mount {
	readonly kind: '--bind' | '--ro-bind'
	readonly source: string
	readonly destination: string
}

const supportedOptions = new Set<string>([
	'cwd',
	'env',
	'extendEnv',
	'shell',
	'detached',
	'windowsHide',
	'stdin',
	'stdout',
	'stderr',
	'additionalFds',
	'killSignal',
	'forceKillAfter',
])

const badArgument = (method: string, description: string) =>
	PlatformError.badArgument({ module: 'Capsule', method, description })

const contains = (parent: string, child: string) =>
	child === parent || child.startsWith(parent === '/' ? '/' : `${parent}/`)

const depth = (mount: Mount) => mount.destination.split('/').filter((part) => part !== '').length

const capsuleEnvironment = (config: SandboxConfig): Record<string, string> => ({
	HOME: config.home,
	TMPDIR: config.temporary,
	TMP: config.temporary,
	TEMP: config.temporary,
	TEMPDIR: config.temporary,
	XDG_RUNTIME_DIR: config.runtime,
	XDG_CONFIG_HOME: `${config.home}/.config`,
	XDG_CACHE_HOME: `${config.home}/.cache`,
	XDG_STATE_HOME: `${config.home}/.local/state`,
})

const planMounts = Effect.fnUntraced(function* (config: SandboxConfig, path: Path.Path) {
	const { shell, env } = config
	const writable = [
		config.directory,
		config.home,
		config.temporary,
		config.runtime,
		...(config.readWrite ?? []),
	]
	for (const location of [config.bwrap, shell, env, ...writable, ...config.readOnly]) {
		if (!path.isAbsolute(location) || path.resolve(location) !== location)
			return yield* badArgument(
				'makeSandboxSpawner',
				`The path ${location} must be absolute and normalized`,
			)
	}

	const mounts: Array<Mount> = [
		{ kind: '--ro-bind', source: '/nix/store', destination: '/nix/store' },
		{ kind: '--bind', source: config.temporary, destination: '/tmp' },
		{ kind: '--ro-bind', source: shell, destination: '/bin/sh' },
		{ kind: '--ro-bind', source: env, destination: '/usr/bin/env' },
		...writable.map(
			(location): Mount => ({ kind: '--bind', source: location, destination: location }),
		),
		...config.readOnly.map(
			(location): Mount => ({ kind: '--ro-bind', source: location, destination: location }),
		),
	]
	const planned = new Map<string, Mount>()
	for (const mount of mounts) {
		const existing = planned.get(mount.destination)
		if (existing === undefined) planned.set(mount.destination, mount)
		else if (existing.kind !== mount.kind || existing.source !== mount.source)
			return yield* badArgument(
				'makeSandboxSpawner',
				`The mount ${mount.destination} is configured with conflicting sources`,
			)
	}
	// Bubblewrap applies mounts in order, so parents must precede the mounts nested in them.
	return [...planned.values()].sort((left, right) => depth(left) - depth(right))
})

export const makeSandboxCommand = Effect.fn('Capsule.makeSandboxCommand')(function* (
	config: SandboxConfig,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path

	const mounts = yield* planMounts(config, path)
	yield* Effect.forEach(
		[config.bwrap, ...mounts.map(({ source }) => source)],
		(location) => fs.access(location),
		{ discard: true },
	)

	const builtIn = capsuleEnvironment(config)
	const collision = Object.keys(config.reserved).find((name) => Object.hasOwn(builtIn, name))
	if (collision !== undefined)
		return yield* badArgument(
			'makeSandboxSpawner',
			`The environment variable ${collision} is managed by the capsule`,
		)
	const reserved = { ...config.reserved, ...builtIn }
	const baseEnvironment: Record<string, EnvironmentValue> = {}
	for (const [name, value] of Object.entries(config.environment))
		if (value !== undefined) baseEnvironment[name] = value
	const basePath = config.basePath.split(':').filter((entry) => entry !== '')

	const sandboxArguments = [
		'--unshare-pid',
		'--die-with-parent',
		'--proc',
		'/proc',
		'--dev',
		'/dev',
		...mounts.flatMap(({ kind, source, destination }) => [kind, source, destination]),
	]

	const workingDirectory = Effect.fnUntraced(function* (cwd: string | undefined) {
		const sandbox = path.resolve(config.directory, cwd ?? '.')
		const mount = mounts.filter(({ destination }) => contains(destination, sandbox)).at(-1)
		if (mount === undefined)
			return yield* badArgument(
				'spawn',
				`The working directory ${sandbox} is outside the capsule's mounts`,
			)
		return { sandbox, host: path.join(mount.source, path.relative(mount.destination, sandbox)) }
	})

	const searchPath = (current: EnvironmentValue | undefined) => {
		const value = Redacted.isRedacted(current) ? Redacted.value(current) : (current ?? '')
		const entries = value.split(':').filter((entry) => entry !== '')
		return [...basePath, ...entries.filter((entry) => !basePath.includes(entry))].join(':')
	}

	// Values travel in the child environment rather than `--setenv` arguments, which error
	// descriptions and process listings would expose.
	const environmentFor = Effect.fnUntraced(function* (options: ChildProcess.CommandOptions) {
		const inherits = options.env === undefined || options.extendEnv === true
		const environment: Record<string, EnvironmentValue> = inherits ? { ...baseEnvironment } : {}
		for (const [name, value] of Object.entries(options.env ?? {})) {
			if (Object.hasOwn(reserved, name))
				return yield* badArgument(
					'spawn',
					`The environment variable ${name} is reserved by the capsule`,
				)
			if (value === undefined) delete environment[name]
			else environment[name] = value
		}
		return { ...environment, PATH: searchPath(environment.PATH), ...reserved }
	})

	const sandboxStandard = Effect.fnUntraced(function* (command: ChildProcess.StandardCommand) {
		const unsupported = Object.keys(command.options).filter((name) => !supportedOptions.has(name))
		if (unsupported.length > 0)
			return yield* badArgument('spawn', `Unsupported command options: ${unsupported.join(', ')}`)
		const { cwd, env: _env, extendEnv: _extendEnv, shell, ...options } = command.options
		const usesShell = shell !== undefined && shell !== false
		if (usesShell && command.args.length > 0)
			return yield* badArgument(
				'spawn',
				'The shell option cannot be combined with arguments; pass the whole script as the command',
			)

		const directory = yield* workingDirectory(cwd)
		const environment = yield* environmentFor(command.options)
		const payload = usesShell
			? [shell === true ? '/bin/sh' : shell, '-c', command.command]
			: [command.command, ...command.args]
		return ChildProcess.make(
			config.bwrap,
			[...sandboxArguments, '--chdir', directory.sandbox, '--', ...payload],
			{ ...options, cwd: directory.host, env: environment, extendEnv: false },
		)
	})

	const sandbox = (
		command: ChildProcess.Command,
	): Effect.Effect<ChildProcess.Command, PlatformError.PlatformError> => {
		switch (command._tag) {
			case 'StandardCommand':
				return sandboxStandard(command)
			case 'PipedCommand':
				return Effect.gen(function* () {
					const left = yield* sandbox(command.left)
					const right = yield* sandbox(command.right)
					return ChildProcess.pipeTo(left, right, command.options)
				})
		}
	}

	return sandbox
})

/**
 * Each command and pipeline stage owns a PID namespace. Descendants end when the command exits
 * or its scope closes. The supplied host spawner retains stream and process ownership.
 */
export const makeSandboxSpawner = Effect.fn('Capsule.makeSandboxSpawner')(function* (
	config: SandboxConfig,
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const sandbox = yield* makeSandboxCommand(config)
	return ChildProcessSpawner.make(
		Effect.fn('Capsule.spawn')(function* (command) {
			const sandboxed = yield* sandbox(command)
			return yield* spawner.spawn(sandboxed)
		}),
	)
})
