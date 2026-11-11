import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
	access,
	constants,
	link,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer, type Socket } from 'node:net'
import { delimiter, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, ManagedRuntime, PlatformError, Schema } from 'effect'
import { describe, expect, it, onTestFinished } from 'vitest'
import { SupervisorEnvironment } from '../workspace/lock-supervisor'
import { type PrepareInput, WorkspaceStatus } from '../workspace/schema'
import { make, WorkspaceService } from '../workspace/service'

const execute = promisify(execFile)
const taskId = 'a4ea0530-d3eb-4e0d-afc5-dda8e9e50b00'

async function executable(name: string) {
	for (const directory of (process.env.PATH ?? '').split(delimiter)) {
		const file = join(directory, name)
		try {
			await access(file, constants.X_OK)
			return file
		} catch {}
	}
	throw new Error(`Missing test executable: ${name}`)
}

async function fixture(
	options: {
		failCommand?: {
			readonly executable: 'git' | 'tar'
			readonly argument: string
			readonly once: boolean
		}
		fileSystem?: (fs: FileSystem.FileSystem) => FileSystem.FileSystem
	} = {},
) {
	const directory = await mkdtemp('/tmp/opencode/pipeline-workspace-')
	const cleanup: Array<() => Promise<unknown>> = []
	const gitExecutable = await executable('git')
	const home = join(directory, 'home')
	await mkdir(home)
	const environment = {
		PATH: process.env.PATH,
		HOME: home,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
		GIT_TERMINAL_PROMPT: '0',
		LC_ALL: 'C',
		GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
		GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
	}
	const git = async (cwd: string, ...args: string[]) => {
		const { stdout } = await execute(gitExecutable, ['-c', 'core.hooksPath=/dev/null', ...args], {
			cwd,
			env: environment,
		})
		return stdout.trim()
	}
	const seed = join(directory, 'seed')
	await git(directory, 'init', '--initial-branch=main', seed)
	await git(seed, 'config', 'user.name', 'Fixture')
	await git(seed, 'config', 'user.email', 'fixture@example.invalid')
	await writeFile(join(seed, 'tracked.txt'), 'initial\n')
	await writeFile(join(seed, 'other.txt'), 'other\n')
	await git(seed, 'add', '.')
	await git(seed, 'commit', '-m', 'initial')
	const initialSha = await git(seed, 'rev-parse', 'HEAD')
	const target = join(directory, 'target.git')
	const source = join(directory, 'source.git')
	await git(directory, 'clone', '--bare', seed, target)
	await git(seed, 'switch', '-c', 'feature/fork')
	await writeFile(join(seed, 'feature.txt'), 'fork feature\n')
	await git(seed, 'add', '.')
	await git(seed, 'commit', '-m', 'fork feature')
	const headSha = await git(seed, 'rev-parse', 'HEAD')
	await git(directory, 'clone', '--bare', seed, source)
	await git(seed, 'switch', 'main')
	await writeFile(join(seed, 'target-only.txt'), 'new target base\n')
	await git(seed, 'add', '.')
	await git(seed, 'commit', '-m', 'new target base')
	const baseSha = await git(seed, 'rev-parse', 'HEAD')
	await git(seed, 'push', target, 'main')
	await git(target, 'fetch', source, 'feature/fork')
	await git(target, 'update-ref', 'refs/pull/7/head', headSha)
	if (options.failCommand !== undefined) {
		const fault = options.failCommand
		const bin = join(directory, 'bin')
		await mkdir(bin)
		const actual = await executable(fault.executable)
		const marker = join(directory, 'fault-injected')
		await writeFile(
			join(bin, fault.executable),
			`#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes(${JSON.stringify(fault.argument)}) && (${!fault.once} || !fs.existsSync(${JSON.stringify(marker)}))) {
 fs.writeFileSync(${JSON.stringify(marker)}, 'injected');
 process.exit(1);
}

const child = cp.spawnSync(${JSON.stringify(actual)}, args, {stdio:['inherit','inherit','inherit',3]});
process.exit(child.status ?? 1);
`,
			{ mode: 0o755 },
		)
		environment.PATH = `${bin}${delimiter}${environment.PATH}`
	}
	const root = join(directory, 'workspaces')
	const input: PrepareInput = {
		taskId,
		repository: 'upstream/project',
		sourceRepository: 'contributor/project',
		prNumber: 7,
		headRef: 'feature/fork',
		headSha,
		baseSha,
	}
	const layer = Layer.effect(
		WorkspaceService,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			return yield* make({
				root,
				repositoryUrl: (repository) => (repository === input.repository ? target : source),
			}).pipe(
				Effect.provideService(SupervisorEnvironment, environment),
				Effect.provideService(FileSystem.FileSystem, options.fileSystem?.(fs) ?? fs),
			)
		}),
	).pipe(Layer.provide(NodeServices.layer))
	const runtime = ManagedRuntime.make(layer)
	const call = <A, E>(operation: (service: WorkspaceService['Service']) => Effect.Effect<A, E>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* WorkspaceService
				return yield* operation(service)
			}),
		)
	const error = (
		operation: (service: WorkspaceService['Service']) => Effect.Effect<unknown, unknown>,
	) => call((service) => Effect.flip(operation(service)))
	const checkout = join(root, taskId, 'checkout')
	const manifest = join(root, taskId, 'manifest.json')
	onTestFinished(async () => {
		try {
			for (const release of [...cleanup].reverse()) await release()
		} finally {
			await runtime.dispose()
			await rm(directory, { recursive: true, force: true })
		}
	})
	return {
		directory,
		root,
		input,
		initialSha,
		target,
		source,
		git,
		call,
		error,
		checkout,
		manifest,
		environment,
		cleanup,
	}
}

async function bundleCli(f: Awaited<ReturnType<typeof fixture>>) {
	const entry = join(f.directory, 'helper.mjs')
	const resolve = createRequire(import.meta.url).resolve
	await writeFile(
		entry,
		`
import { NodeRuntime, NodeServices } from ${JSON.stringify(resolve('@effect/platform-node'))};
import { Effect } from ${JSON.stringify(resolve('effect'))};
import { Command } from ${JSON.stringify(resolve('effect/cli'))};
import { protocolCommand, workspaceCommand } from ${JSON.stringify(fileURLToPath(new URL('../workspace/cli.ts', import.meta.url)))};
const cli = Command.make('pipeline').pipe(Command.withSubcommands([protocolCommand, workspaceCommand]), Command.run({version:'0.1.0'}));
Effect.gen(function* () { yield* Effect.sync(() => process.umask(0o077)); yield* cli; }).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
`,
	)
	const bundle = join(f.directory, 'pipeline.mjs')
	await execute(
		await executable('bun'),
		['build', entry, '--target=node', '--format=esm', '--packages=bundle', '--outfile', bundle],
		{ cwd: f.directory },
	)
	return bundle
}

async function blockedGitHelper(
	f: Awaited<ReturnType<typeof fixture>>,
	mode: 'cli' | 'cancellable' = 'cli',
) {
	const bundler = await executable('bun')
	const runtime = await executable('node')
	const socketPath = join(f.directory, 'writer-socket')
	const server = createServer()
	f.cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
	server.listen(socketPath)
	await once(server, 'listening')
	const writerFile = join(f.directory, 'smudge-writer')
	const lateWork = join(f.root, taskId, 'staging', 'surviving-writer.txt')
	await writeFile(
		writerFile,
		`#!${runtime}
const fs = require('node:fs');
const net = require('node:net');
const client = net.connect(${JSON.stringify(socketPath)});
process.stdin.resume();
client.on('connect', () => client.write(JSON.stringify({
 pid: process.pid, parent: process.ppid,
 lock: fs.readlinkSync('/proc/self/fd/3'), parentLock: fs.readlinkSync('/proc/'+process.ppid+'/fd/3'),
 flags: fs.readFileSync('/proc/'+process.ppid+'/fdinfo/3','utf8')
})+'\\n'));
client.once('data', () => {
 fs.writeFileSync(${JSON.stringify(lateWork)}, 'written after helper death\\n');
 process.stdout.write('initial\\n');
 client.end('finished\\n', () => process.exit(0));
});
client.on('error', () => process.exit(1));
client.on('end', () => process.exit(0));
`,
		{ mode: 0o755 },
	)
	const attributes = join(f.directory, 'attributes')
	await writeFile(attributes, 'tracked.txt filter=blocking\n')
	await writeFile(
		f.environment.GIT_CONFIG_GLOBAL,
		`[core]\n\tattributesFile = ${attributes}\n[filter "blocking"]\n\tsmudge = ${writerFile}\n\trequired = true\n[url "${pathToFileURL(f.target).href}"]\n\tinsteadOf = https://github.com/${f.input.repository}.git\n[url "${pathToFileURL(f.source).href}"]\n\tinsteadOf = https://github.com/${f.input.sourceRepository}.git\n`,
	)
	const helperFile = join(f.directory, 'prepare.mjs')
	const resolve = createRequire(import.meta.url).resolve
	await writeFile(
		helperFile,
		`
import { Effect } from ${JSON.stringify(resolve('effect'))};
import { NodeServices } from ${JSON.stringify(resolve('@effect/platform-node'))};
import { make } from ${JSON.stringify(fileURLToPath(new URL('../workspace/service.ts', import.meta.url)))};
const abort = new AbortController();
process.stdin.once('data', () => abort.abort());
const program = Effect.gen(function* () {
 const service = yield* make({root:${JSON.stringify(f.root)}, repositoryUrl: repo => repo === ${JSON.stringify(f.input.repository)} ? ${JSON.stringify(f.target)} : ${JSON.stringify(f.source)}});
 return yield* service.prepare(${JSON.stringify(f.input)});
}).pipe(Effect.provide(NodeServices.layer));
Effect.runPromise(program, {signal:abort.signal}).then(() => process.exit(0), () => process.exit(abort.signal.aborted ? 0 : 1));
`,
	)
	const bundle = join(f.directory, 'prepare-bundle.mjs')
	await execute(
		bundler,
		[
			'build',
			helperFile,
			'--target=node',
			'--format=esm',
			'--packages=bundle',
			'--outfile',
			bundle,
		],
		{ cwd: f.directory },
	)
	const args =
		mode === 'cli'
			? [
					await bundleCli(f),
					'workspace',
					'--root',
					f.root,
					'--request',
					Buffer.from(JSON.stringify({ operation: 'prepare', input: f.input })).toString(
						'base64url',
					),
				]
			: [bundle]
	const helper = spawn(runtime, ['--disable-warning=ExperimentalWarning', ...args], {
		cwd: f.directory,
		env: f.environment,
		stdio: ['pipe', 'ignore', 'pipe'],
	})
	const exited = once(helper, 'exit')
	f.cleanup.push(async () => {
		if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL')
		await exited
	})
	const [socket] = await Promise.race([
		once(server, 'connection') as Promise<[Socket]>,
		exited.then(() => {
			throw new Error('Workspace helper exited before its writer became active.')
		}),
	])
	f.cleanup.push(async () => {
		if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL')
		if (!socket.destroyed) socket.end('finish\n')
		await execute(
			'flock',
			['--exclusive', join(f.root, '.workspace.lock'), runtime, '-e', 'process.exit(0)'],
			{ timeout: 10_000 },
		)
		socket.destroy()
	})
	const [ready] = await Promise.race([
		once(socket, 'data'),
		exited.then(() => {
			throw new Error('Workspace writer stopped before reporting its inherited lock.')
		}),
	])
	const writer: { pid: number; parent: number; lock: string; parentLock: string; flags: string } =
		JSON.parse(ready.toString())
	return { helper, exited, socket, writer, lateWork, runtime }
}

async function pausedArchiveHelper(f: Awaited<ReturnType<typeof fixture>>) {
	const runtime = await executable('node')
	const bundler = await executable('bun')
	const socketPath = join(f.directory, 'paused-socket')
	const server = createServer()
	f.cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
	server.listen(socketPath)
	await once(server, 'listening')
	const resolve = createRequire(import.meta.url).resolve
	const entry = join(f.directory, 'archive.mjs')
	await writeFile(
		entry,
		`
import { Deferred, Effect, FileSystem } from ${JSON.stringify(resolve('effect'))};
import { NodeServices } from ${JSON.stringify(resolve('@effect/platform-node'))};
import { make } from ${JSON.stringify(fileURLToPath(new URL('../workspace/service.ts', import.meta.url)))};
import fsNative from 'node:fs';
import net from 'node:net';
const client = net.connect(${JSON.stringify(socketPath)});
client.on('error', () => process.exit(1));
const program = Effect.gen(function* () {
 const fs = yield* FileSystem.FileSystem;
 const permit = yield* Deferred.make();
 client.once('data', () => Effect.runFork(Deferred.succeed(permit, undefined)));
 const guarded = {...fs, open: (path, options) => Effect.gen(function* () {
  if (path.endsWith('/.manifest.next')) {
   if (!(yield* Deferred.isDone(permit))) {
    const children = fsNative.readFileSync('/proc/self/task/'+process.pid+'/children', 'utf8').trim().split(' ').filter(Boolean).map(Number);
    client.write(JSON.stringify({children})+'\\n');
   }
   yield* Deferred.await(permit);
  }
  return yield* fs.open(path, options);
 })};
 const service = yield* make({root:${JSON.stringify(f.root)}}).pipe(Effect.provideService(FileSystem.FileSystem, guarded));
 return yield* service.archive(${JSON.stringify(f.input)});
}).pipe(Effect.provide(NodeServices.layer));
const finish = () => client.end('finished\\n', () => process.exit(0));
Effect.runPromise(program).then(finish, finish);
`,
	)
	const bundle = join(f.directory, 'paused-archive.mjs')
	await execute(
		bundler,
		['build', entry, '--target=node', '--format=esm', '--packages=bundle', '--outfile', bundle],
		{ cwd: f.directory },
	)
	const helper = spawn(runtime, [bundle], {
		cwd: f.directory,
		env: f.environment,
		stdio: ['ignore', 'ignore', 'ignore'],
	})
	const exited = once(helper, 'exit')
	f.cleanup.push(async () => {
		if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL')
		await exited
		await execute(
			'flock',
			['--exclusive', join(f.root, '.workspace.lock'), runtime, '-e', 'process.exit(0)'],
			{ timeout: 10_000 },
		)
	})
	const [socket] = await Promise.race([
		once(server, 'connection') as Promise<[Socket]>,
		exited.then(() => {
			throw new Error('Archive helper exited before reaching its write boundary.')
		}),
	])
	f.cleanup.push(async () => {
		socket.destroy()
	})
	const [ready] = await Promise.race([
		once(socket, 'data'),
		exited.then(() => {
			throw new Error('Archive helper stopped before reporting its write boundary.')
		}),
	])
	const paused: { children: Array<number> } = JSON.parse(ready.toString())
	return { helper, exited, socket, paused }
}

describe('worker workspaces', () => {
	it('runs the bundled protocol-2 helper with typed prepare/inspect requests and retains work without remote access', async () => {
		const f = await fixture()
		const bundle = await bundleCli(f)
		const runtime = await executable('node')
		const call = async (...args: string[]) =>
			execute(runtime, ['--disable-warning=ExperimentalWarning', bundle, ...args], {
				cwd: f.directory,
				env: f.environment,
			})
		expect(JSON.parse((await call('protocol')).stdout)).toEqual({ protocolVersion: 2 })
		const request = async (body: unknown) =>
			JSON.parse(
				(
					await call(
						'workspace',
						'--root',
						f.root,
						'--request',
						Buffer.from(JSON.stringify(body)).toString('base64url'),
					)
				).stdout,
			)
		expect(await request({ operation: 'inspect', taskId })).toEqual({
			_tag: 'Absent',
			taskId,
			directory: f.checkout,
		})
		await writeFile(
			f.environment.GIT_CONFIG_GLOBAL,
			`[url "${pathToFileURL(f.target).href}"]\n\tinsteadOf = https://github.com/${f.input.repository}.git\n[url "${pathToFileURL(f.source).href}"]\n\tinsteadOf = https://github.com/${f.input.sourceRepository}.git\n`,
		)
		const ready = await request({ operation: 'prepare', input: f.input })
		expect(ready).toEqual({ _tag: 'Ready', taskId, directory: f.checkout })
		await writeFile(join(f.checkout, 'retained.txt'), 'local worker work\n')
		await rm(f.source, { recursive: true })
		await rm(f.target, { recursive: true })
		expect(await request({ operation: 'prepare', input: f.input })).toEqual(ready)
		expect(await request({ operation: 'inspect', taskId })).toEqual(ready)
		expect(await readFile(join(f.checkout, 'retained.txt'), 'utf8')).toBe('local worker work\n')
		for (const encoded of [
			'not-json',
			Buffer.from(
				JSON.stringify({ operation: 'prepare', input: { ...f.input, headSha: 'invalid' } }),
			).toString('base64url'),
			Buffer.from(JSON.stringify({ operation: 'release', taskId })).toString('base64url'),
		]) {
			await expect(call('workspace', '--root', f.root, '--request', encoded)).rejects.toMatchObject(
				{ code: 1, stdout: expect.stringContaining('"code":"invalid_input"') },
			)
		}
		expect(await readFile(join(f.checkout, 'retained.txt'), 'utf8')).toBe('local worker work\n')
	}, 20_000)

	it('does not inspect lifecycle state while another helper owns the writer lock', async () => {
		const f = await fixture()
		await f.call((service) => service.prepare(f.input))
		const holder = spawn(
			'flock',
			[
				'--exclusive',
				join(f.root, '.workspace.lock'),
				await executable('node'),
				'-e',
				'process.stdout.write("locked"); process.stdin.resume()',
			],
			{ stdio: ['pipe', 'pipe', 'ignore'] },
		)
		const exited = once(holder, 'exit')
		f.cleanup.push(async () => {
			if (holder.exitCode === null && holder.signalCode === null) holder.kill()
			await exited
		})
		await once(holder.stdout, 'data')
		expect(await f.error((service) => service.inspect(taskId))).toMatchObject({
			code: 'busy',
		})
		holder.stdin.end()
		await exited
		expect(await f.call((service) => service.inspect(taskId))).toMatchObject({ _tag: 'Ready' })
	})
	it('keeps the filesystem helper locked after its supervisor dies before a manifest write', async () => {
		const f = await fixture()
		const active = await pausedArchiveHelper(f)
		expect(active.paused.children).toHaveLength(1)
		const supervisor = active.paused.children[0]
		if (supervisor === undefined) throw new Error('Missing owned supervisor process.')
		const descriptor = `/proc/${supervisor}/fd/3`
		expect(await readlink(descriptor)).toBe(join(f.root, '.workspace.lock'))
		process.kill(supervisor, 'SIGKILL')
		await expect
			.poll(async () => {
				try {
					await readlink(descriptor)
					return true
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
					throw error
				}
			})
			.toBe(false)
		await expect(stat(f.manifest)).rejects.toMatchObject({ code: 'ENOENT' })
		expect(await f.error((service) => service.prepare(f.input))).toMatchObject({ code: 'busy' })
		expect(await f.error((service) => service.archive(f.input))).toMatchObject({ code: 'busy' })
		expect(await f.error((service) => service.release(taskId))).toMatchObject({ code: 'busy' })
		active.socket.write('continue\n')
		expect(await active.exited).toEqual([0, null])
		expect(JSON.parse(await readFile(f.manifest, 'utf8'))).toMatchObject({
			input: f.input,
			status: { _tag: 'Archiving' },
		})
		expect(await f.call((service) => service.archive(f.input))).toMatchObject({ _tag: 'Archived' })
		expect(await f.call((service) => service.release(taskId))).toMatchObject({ _tag: 'Released' })
	}, 20_000)

	it('archives a never-created task without cloning and fences delayed preparation after release', async () => {
		const f = await fixture()
		await rm(f.source, { recursive: true })
		await rm(f.target, { recursive: true })
		const archived = await f.call((service) => service.archive(f.input))
		if (archived._tag !== 'Archived') throw new Error('Expected Archived')
		expect((await execute('tar', ['--list', '--file', archived.archive.path])).stdout).toBe('')
		expect((await readdir(join(f.root, taskId))).sort()).toEqual(['checkout.tar', 'manifest.json'])
		expect(await f.call((service) => service.archive(f.input))).toEqual(archived)
		const released = await f.call((service) => service.release(taskId))
		expect(released).toEqual({ ...archived, _tag: 'Released' })
		expect(await f.error((service) => service.prepare(f.input))).toMatchObject({
			code: 'illegal_transition',
		})
		expect(await f.call((service) => service.inspect(taskId))).toEqual(released)
		await expect(stat(f.checkout)).rejects.toMatchObject({ code: 'ENOENT' })
	})

	it('rejects archive identity collisions before changing ready or archived ownership records', async () => {
		const f = await fixture()
		await f.call((service) => service.prepare(f.input))
		const ready = await readFile(f.manifest, 'utf8')
		expect(await f.error((service) => service.archive({ ...f.input, prNumber: 8 }))).toMatchObject({
			code: 'input_collision',
		})
		expect(await readFile(f.manifest, 'utf8')).toBe(ready)
		const archived = await f.call((service) => service.archive(f.input))
		const retained = await readFile(f.manifest, 'utf8')
		expect(
			await f.error((service) => service.archive({ ...f.input, headSha: f.initialSha })),
		).toMatchObject({ code: 'input_collision' })
		expect(await readFile(f.manifest, 'utf8')).toBe(retained)
		expect(await f.call((service) => service.inspect(taskId))).toEqual(archived)
	})

	it('keeps the kernel lock across bundled helper SIGKILL until the real Git descendant finishes writing', async () => {
		const f = await fixture()
		const active = await blockedGitHelper(f)
		expect(active.writer.lock).toBe(join(f.root, '.workspace.lock'))
		expect(active.writer.parentLock).toBe(join(f.root, '.workspace.lock'))
		const flags = active.writer.flags.match(/^flags:\s+([0-7]+)$/m)?.[1]
		if (flags === undefined) throw new Error('Writer did not report descriptor flags.')
		expect(Number.parseInt(flags, 8) & 0o2000000).toBe(0)
		const before = await readFile(f.manifest, 'utf8')
		active.helper.kill('SIGKILL')
		expect(await active.exited).toEqual([null, 'SIGKILL'])
		process.kill(active.writer.pid, 0)
		process.kill(active.writer.parent, 0)
		expect(await f.error((service) => service.prepare(f.input))).toMatchObject({ code: 'busy' })
		expect(await f.error((service) => service.archive(f.input))).toMatchObject({ code: 'busy' })
		expect(await f.error((service) => service.release(taskId))).toMatchObject({ code: 'busy' })
		expect(await readFile(f.manifest, 'utf8')).toBe(before)
		active.socket.write('finish\n')
		await once(active.socket, 'end')
		await execute(
			'flock',
			['--exclusive', join(f.root, '.workspace.lock'), active.runtime, '-e', 'process.exit(0)'],
			{ timeout: 10_000 },
		)
		expect(await readFile(active.lateWork, 'utf8')).toBe('written after helper death\n')
		const archived = await f.call((service) => service.archive(f.input))
		if (archived._tag !== 'Archived') throw new Error('Expected Archived')
		expect(
			(
				await execute('tar', [
					'--extract',
					'--to-stdout',
					'--file',
					archived.archive.path,
					'staging/surviving-writer.txt',
				])
			).stdout,
		).toBe('written after helper death\n')
		expect(await f.call((service) => service.release(taskId))).toMatchObject({ _tag: 'Released' })
	}, 20_000)

	it('cancels the supervised Git process group before allowing another workspace operation', async () => {
		const f = await fixture()
		const active = await blockedGitHelper(f, 'cancellable')
		const writerClosed = once(active.socket, 'close')
		active.helper.stdin.write('cancel\n')
		await active.exited
		await writerClosed
		await execute(
			'flock',
			['--exclusive', join(f.root, '.workspace.lock'), active.runtime, '-e', 'process.exit(0)'],
			{ timeout: 10_000 },
		)
		await expect(stat(active.lateWork)).rejects.toMatchObject({ code: 'ENOENT' })
		expect(await f.call((service) => service.archive(f.input))).toMatchObject({ _tag: 'Archived' })
		expect(await f.call((service) => service.release(taskId))).toMatchObject({ _tag: 'Released' })
	}, 20_000)

	it('adopts the same fork input without resetting commits, staged changes, or untracked work', async () => {
		const f = await fixture()
		expect(await f.call((service) => service.inspect(taskId))).toEqual({
			_tag: 'Absent',
			taskId,
			directory: f.checkout,
		})
		const ready = await f.call((service) => service.prepare(f.input))
		expect(ready).toEqual({ _tag: 'Ready', taskId, directory: f.checkout })
		expect(await f.git(f.checkout, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature/fork')
		expect(await f.git(f.checkout, 'remote', 'get-url', '--push', 'origin')).toBe(f.source)
		expect(
			await f.git(f.checkout, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'),
		).toBe('origin/feature/fork')
		expect(await f.git(f.checkout, 'rev-parse', '--is-shallow-repository')).toBe('false')
		await f.git(f.checkout, 'cat-file', '-e', `${f.input.baseSha}^{commit}`)
		await f.git(f.checkout, 'config', 'user.name', 'Worker')
		await f.git(f.checkout, 'config', 'user.email', 'worker@example.invalid')
		await writeFile(join(f.checkout, 'tracked.txt'), 'unpublished commit\n')
		await f.git(f.checkout, 'add', 'tracked.txt')
		await f.git(f.checkout, 'commit', '-m', 'worker commit')
		const head = await f.git(f.checkout, 'rev-parse', 'HEAD')
		await writeFile(join(f.checkout, 'tracked.txt'), 'staged work\n')
		await f.git(f.checkout, 'add', 'tracked.txt')
		await writeFile(join(f.checkout, 'tracked.txt'), 'unstaged work\n')
		await writeFile(join(f.checkout, 'untracked.txt'), 'untracked work\n')
		const before = await f.git(f.checkout, 'status', '--porcelain=v1')
		await f.git(f.source, 'update-ref', 'refs/heads/feature/fork', f.initialSha)
		await f.git(f.target, 'update-ref', 'refs/pull/7/head', f.initialSha)
		await rm(f.source, { recursive: true })
		await rm(f.target, { recursive: true })
		const reordered = Object.fromEntries(Object.entries(f.input).reverse()) as PrepareInput
		expect(await f.call((service) => service.prepare(reordered))).toEqual(ready)
		expect(await f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(head)
		expect(await f.git(f.checkout, 'status', '--porcelain=v1')).toBe(before)
		expect(await readdir(join(f.root, taskId))).not.toContain('staging')
	})

	it('rejects task input collisions without changing the existing manifest or checkout', async () => {
		const f = await fixture()
		await f.call((service) => service.prepare(f.input))
		const manifest = await readFile(f.manifest, 'utf8')
		expect(
			await f.error((service) => service.prepare({ ...f.input, headRef: 'other-branch' })),
		).toMatchObject({ code: 'input_collision' })
		expect(await readFile(f.manifest, 'utf8')).toBe(manifest)
		expect(await f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(f.input.headSha)
	})

	it('resumes a failed fetch without discarding work in the owned staging checkout', async () => {
		const f = await fixture({ failCommand: { executable: 'git', argument: 'fetch', once: true } })
		expect(await f.error((service) => service.prepare(f.input))).toMatchObject({
			code: 'git_failed',
		})
		expect(await f.call((service) => service.inspect(taskId))).toMatchObject({
			_tag: 'Preparing',
			step: 'configure',
		})
		const staging = join(f.root, taskId, 'staging')
		await writeFile(join(staging, 'tracked.txt'), 'interrupted preparation work\n')
		await writeFile(join(staging, 'recover.txt'), 'retained\n')
		expect(await f.call((service) => service.prepare(f.input))).toMatchObject({ _tag: 'Ready' })
		expect(await readFile(join(f.checkout, 'tracked.txt'), 'utf8')).toBe(
			'interrupted preparation work\n',
		)
		expect(await readFile(join(f.checkout, 'recover.txt'), 'utf8')).toBe('retained\n')
	})

	it('archives and releases failed provisioning, including an incomplete owned clone', async () => {
		const f = await fixture({ failCommand: { executable: 'git', argument: 'clone', once: false } })
		expect(await f.error((service) => service.prepare(f.input))).toMatchObject({
			code: 'git_failed',
		})
		const staging = join(f.root, taskId, 'staging')
		await mkdir(join(staging, '.git', 'objects'), { recursive: true })
		await writeFile(join(staging, '.git', 'objects', 'incomplete.pack'), 'partial fetch bytes\n')
		await writeFile(join(staging, 'recover.txt'), 'not published\n')
		const archived = await f.call((service) => service.archive(f.input))
		if (archived._tag !== 'Archived') throw new Error('Expected Archived')
		const restored = join(f.directory, 'partial-restore')
		await mkdir(restored)
		await execute('tar', ['--extract', '--file', archived.archive.path, '--directory', restored])
		expect(
			await readFile(join(restored, 'staging', '.git', 'objects', 'incomplete.pack'), 'utf8'),
		).toBe('partial fetch bytes\n')
		expect(await readFile(join(restored, 'staging', 'recover.txt'), 'utf8')).toBe('not published\n')
		expect(await f.call((service) => service.release(taskId))).toMatchObject({ _tag: 'Released' })
		await expect(stat(staging)).rejects.toMatchObject({ code: 'ENOENT' })
		expect(await f.error((service) => service.prepare(f.input))).toMatchObject({
			code: 'illegal_transition',
		})
	})

	it('retains an empty archive and tombstone when preparation stopped before clone', async () => {
		const f = await fixture()
		await f.git(f.target, 'update-ref', 'refs/pull/7/head', f.initialSha)
		expect(await f.error((service) => service.prepare(f.input))).toMatchObject({
			code: 'stale_head',
		})
		const archived = await f.call((service) => service.archive(f.input))
		if (archived._tag !== 'Archived') throw new Error('Expected Archived')
		expect((await execute('tar', ['--list', '--file', archived.archive.path])).stdout).toBe('')
		expect(await f.call((service) => service.release(taskId))).toMatchObject({ _tag: 'Released' })
		expect((await stat(archived.archive.path)).size).toBe(archived.archive.bytes)
	})

	it('disables configured Git hooks during clone provisioning', async () => {
		const f = await fixture()
		const hooks = join(f.directory, 'configured-hooks')
		await mkdir(hooks)
		await writeFile(join(hooks, 'post-checkout'), '#!/bin/sh\nexit 99\n', { mode: 0o755 })
		await writeFile(f.environment.GIT_CONFIG_GLOBAL, `[core]\n\thooksPath = ${hooks}\n`)
		expect(await f.call((service) => service.prepare(f.input))).toMatchObject({ _tag: 'Ready' })
	})

	it('persists prepare intent and rejects moved pull request or source heads before provisioning', async () => {
		const f = await fixture()
		await f.git(f.target, 'update-ref', 'refs/pull/7/head', f.initialSha)
		expect(await f.error((service) => service.prepare(f.input))).toMatchObject({
			code: 'stale_head',
		})
		expect(await f.call((service) => service.inspect(taskId))).toMatchObject({
			_tag: 'Preparing',
			step: 'clone',
		})
		await expect(stat(f.checkout)).rejects.toMatchObject({ code: 'ENOENT' })
		await f.git(f.target, 'update-ref', 'refs/pull/7/head', f.input.headSha)
		await f.git(f.source, 'update-ref', 'refs/heads/feature/fork', f.initialSha)
		expect(await f.error((service) => service.prepare(f.input))).toMatchObject({
			code: 'stale_head',
		})
		await expect(stat(f.checkout)).rejects.toMatchObject({ code: 'ENOENT' })
		await f.git(f.source, 'update-ref', 'refs/heads/feature/fork', f.input.headSha)
		expect(await f.call((service) => service.prepare(f.input))).toMatchObject({ _tag: 'Ready' })
		expect(await f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(f.input.headSha)
	})

	it('rejects invalid wire input before creating task files', async () => {
		const f = await fixture()
		for (const invalid of [
			{ ...f.input, taskId: '../outside' },
			{ ...f.input, repository: 'https://secret@github.com/owner/repo' },
			{ ...f.input, headRef: 'branch/../../outside' },
			{ ...f.input, headRef: '--upload-pack=bad' },
			{ ...f.input, headSha: 'not-a-sha' },
		])
			expect(await f.error((service) => service.prepare(invalid))).toMatchObject({
				code: 'invalid_input',
			})
		await expect(stat(f.root)).rejects.toMatchObject({ code: 'ENOENT' })
	})

	it('refuses task and checkout symlinks without traversing or deleting the target', async () => {
		const f = await fixture()
		const outside = join(f.directory, 'unrelated')
		await mkdir(outside)
		await writeFile(join(outside, 'keep'), 'unrelated data')
		await mkdir(f.root)
		await symlink(outside, join(f.root, taskId))
		expect(await f.error((service) => service.prepare(f.input))).toMatchObject({
			code: 'unsafe_path',
		})
		await rm(join(f.root, taskId))
		await f.call((service) => service.prepare(f.input))
		await rename(f.checkout, `${f.checkout}.saved`)
		await symlink(outside, f.checkout)
		expect(await f.error((service) => service.archive(f.input))).toMatchObject({
			code: 'unsafe_path',
		})
		expect(await f.error((service) => service.release(taskId))).toMatchObject({
			code: 'unsafe_path',
		})
		expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('unrelated data')
		expect(await stat(`${f.checkout}.saved/.git`)).toMatchObject({})
	})

	it('refuses control and Git-metadata symlinks while preserving recoverable files', async () => {
		const f = await fixture()
		await f.call((service) => service.prepare(f.input))
		const savedManifest = `${f.manifest}.saved`
		await rename(f.manifest, savedManifest)
		await symlink(savedManifest, f.manifest)
		expect(await f.error((service) => service.inspect(taskId))).toMatchObject({
			code: 'unsafe_path',
		})
		await rm(f.manifest)
		await rename(savedManifest, f.manifest)
		const gitConfig = join(f.checkout, '.git', 'config')
		const externalConfig = join(f.directory, 'external-config')
		await rename(gitConfig, externalConfig)
		const unchangedConfig = await readFile(externalConfig, 'utf8')
		await symlink(externalConfig, gitConfig)
		expect(await f.error((service) => service.prepare(f.input))).toMatchObject({
			code: 'unsafe_path',
		})
		expect(await readFile(externalConfig, 'utf8')).toBe(unchangedConfig)
		await rm(gitConfig)
		await rename(externalConfig, gitConfig)
		await rename(join(f.checkout, '.git'), join(f.directory, 'saved.git'))
		await symlink(join(f.directory, 'saved.git'), join(f.checkout, '.git'))
		expect(await f.error((service) => service.archive(f.input))).toMatchObject({
			code: 'unsafe_path',
		})
		expect(await readFile(join(f.checkout, 'tracked.txt'), 'utf8')).toBe('initial\n')
	})

	it('refuses to archive or release task directories without an ownership manifest', async () => {
		const f = await fixture()
		await mkdir(join(f.root, taskId), { recursive: true, mode: 0o700 })
		expect(await f.error((service) => service.archive(f.input))).toMatchObject({
			code: 'ownership_mismatch',
		})
		const unowned = join(f.root, taskId, 'unrelated.txt')
		await writeFile(unowned, 'unowned data\n')
		expect(await f.error((service) => service.archive(f.input))).toMatchObject({
			code: 'ownership_mismatch',
		})
		expect(await f.error((service) => service.release(taskId))).toMatchObject({
			code: 'illegal_transition',
		})
		expect(await f.error((service) => service.prepare(f.input))).toMatchObject({
			code: 'ownership_mismatch',
		})
		expect(await readFile(unowned, 'utf8')).toBe('unowned data\n')
		await writeFile(f.manifest, 'invalid manifest')
		expect(await f.error((service) => service.archive(f.input))).toMatchObject({
			code: 'invalid_manifest',
		})
		expect(await readFile(f.manifest, 'utf8')).toBe('invalid manifest')
	})

	it('refuses hard-linked control files instead of overwriting unrelated data', async () => {
		const f = await fixture()
		await f.call((service) => service.prepare(f.input))
		const unrelated = join(f.directory, 'unrelated-data')
		await writeFile(unrelated, 'keep unrelated content\n')
		await link(unrelated, join(f.root, taskId, '.manifest.next'))
		expect(await f.error((service) => service.archive(f.input))).toMatchObject({
			code: 'unsafe_path',
		})
		expect(await readFile(unrelated, 'utf8')).toBe('keep unrelated content\n')
		expect(await f.call((service) => service.inspect(taskId))).toMatchObject({ _tag: 'Ready' })
	})

	it('retains full Git history, index, dirty files, ignored files, and symlinks after release', async () => {
		const f = await fixture()
		await f.call((service) => service.prepare(f.input))
		await f.git(f.checkout, 'config', 'user.name', 'Worker')
		await f.git(f.checkout, 'config', 'user.email', 'worker@example.invalid')
		await writeFile(join(f.checkout, 'tracked.txt'), 'unpublished commit\n')
		await f.git(f.checkout, 'add', 'tracked.txt')
		await f.git(f.checkout, 'commit', '-m', 'unpublished worker history')
		const unpublished = await f.git(f.checkout, 'rev-parse', 'HEAD')
		const tree = await f.git(f.checkout, 'rev-parse', 'HEAD^{tree}')
		const dangling = await f.git(
			f.checkout,
			'commit-tree',
			tree,
			'-p',
			f.initialSha,
			'-m',
			'recoverable dangling commit',
		)
		await writeFile(join(f.checkout, 'tracked.txt'), 'staged\n')
		await f.git(f.checkout, 'add', 'tracked.txt')
		await writeFile(join(f.checkout, 'tracked.txt'), 'unstaged after staging\n')
		await writeFile(join(f.checkout, 'other.txt'), 'unstaged second file\n')
		await writeFile(join(f.checkout, 'untracked.txt'), 'untracked\n')
		await writeFile(join(f.checkout, '.gitignore'), 'ignored.bin\n')
		await writeFile(join(f.checkout, 'ignored.bin'), 'ignored but recoverable\n')
		const outside = join(f.directory, 'outside.txt')
		await writeFile(outside, 'do not follow\n')
		await symlink(outside, join(f.checkout, 'outside-link'))
		const staged = await f.git(f.checkout, 'diff', '--cached')
		const unstaged = await f.git(f.checkout, 'diff')
		const archived = await f.call((service) => service.archive(f.input))
		if (archived._tag !== 'Archived') throw new Error('Expected Archived')
		expect(Schema.is(WorkspaceStatus)(archived)).toBe(true)
		const archiveBytes = await readFile(archived.archive.path)
		expect(archived.archive.bytes).toBe(archiveBytes.length)
		expect(archived.archive.sha256).toBe(createHash('sha256').update(archiveBytes).digest('hex'))
		const restore = join(f.directory, 'restore')
		await mkdir(restore)
		await execute('tar', ['--extract', '--file', archived.archive.path, '--directory', restore])
		const recovered = join(restore, 'checkout')
		expect(await f.git(recovered, 'rev-parse', 'HEAD')).toBe(unpublished)
		expect(await f.git(recovered, 'cat-file', '-t', dangling)).toBe('commit')
		expect(await f.git(recovered, 'diff', '--cached')).toBe(staged)
		expect(await f.git(recovered, 'diff')).toBe(unstaged)
		expect(await readFile(join(recovered, 'untracked.txt'), 'utf8')).toBe('untracked\n')
		expect(await readFile(join(recovered, 'ignored.bin'), 'utf8')).toBe('ignored but recoverable\n')
		expect(await readlink(join(recovered, 'outside-link'))).toBe(outside)
		await f.git(recovered, 'fsck', '--full')
		const released = await f.call((service) => service.release(taskId))
		expect(released).toEqual({ ...archived, _tag: 'Released' })
		await expect(stat(f.checkout)).rejects.toMatchObject({ code: 'ENOENT' })
		expect(await readFile(archived.archive.path)).toEqual(archiveBytes)
		expect(await stat(f.manifest)).toMatchObject({ size: expect.any(Number) })
		expect((await stat(f.manifest)).size).toBeLessThan(2048)
		expect(await readFile(outside, 'utf8')).toBe('do not follow\n')
		expect(await f.error((service) => service.prepare(f.input))).toMatchObject({
			code: 'illegal_transition',
		})
		expect(await f.call((service) => service.inspect(taskId))).toEqual(released)
		expect(await f.call((service) => service.release(taskId))).toEqual(released)
	}, 20_000)

	it('retains archiving intent, checkout, and partial archive when verification fails, then resumes', async () => {
		const f = await fixture({
			failCommand: { executable: 'tar', argument: '--compare', once: true },
		})
		await f.call((service) => service.prepare(f.input))
		await writeFile(join(f.checkout, 'precious.txt'), 'keep me\n')
		expect(await f.error((service) => service.archive(f.input))).toMatchObject({
			code: 'archive_failed',
		})
		expect(await f.call((service) => service.inspect(taskId))).toMatchObject({ _tag: 'Archiving' })
		expect(await readFile(join(f.checkout, 'precious.txt'), 'utf8')).toBe('keep me\n')
		expect((await stat(join(f.root, taskId, 'checkout.tar.partial'))).size).toBeGreaterThan(0)
		expect(await f.error((service) => service.prepare(f.input))).toMatchObject({
			code: 'illegal_transition',
		})
		expect(await f.call((service) => service.archive(f.input))).toMatchObject({ _tag: 'Archived' })
	})

	it('does not release a modified archive or newly added post-archive work', async () => {
		const f = await fixture()
		await f.call((service) => service.prepare(f.input))
		expect(await f.error((service) => service.release(taskId))).toMatchObject({
			code: 'illegal_transition',
		})
		const archived = await f.call((service) => service.archive(f.input))
		if (archived._tag !== 'Archived') throw new Error('Expected Archived')
		await writeFile(join(f.checkout, 'late-untracked.txt'), 'late work\n')
		expect(await f.error((service) => service.release(taskId))).toMatchObject({
			code: 'archive_changed',
		})
		expect(await readFile(join(f.checkout, 'late-untracked.txt'), 'utf8')).toBe('late work\n')
		expect(await f.call((service) => service.inspect(taskId))).toMatchObject({ _tag: 'Archived' })
		await writeFile(archived.archive.path, 'corrupted archive')
		expect(await f.error((service) => service.release(taskId))).toMatchObject({
			code: 'archive_changed',
		})
		expect(await f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(f.input.headSha)
	})

	it('refuses entries tar cannot preserve rather than silently deleting them on release', async () => {
		const f = await fixture()
		await f.call((service) => service.prepare(f.input))
		const socket = join(f.checkout, 's')
		const server = createServer()
		await new Promise<void>((resolve) => server.listen(socket, resolve))
		try {
			expect(await f.error((service) => service.archive(f.input))).toMatchObject({
				code: 'archive_failed',
			})
			expect((await stat(socket)).isSocket()).toBe(true)
			expect(await f.call((service) => service.inspect(taskId))).toMatchObject({
				_tag: 'Archiving',
			})
			expect(await f.error((service) => service.release(taskId))).toMatchObject({
				code: 'illegal_transition',
			})
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			)
		}
	})

	it('resumes a partially deleted checkout from durable releasing intent without losing its archive', async () => {
		let failRemoval = true
		const f = await fixture({
			fileSystem: (fs) => ({
				...fs,
				remove: (file, options) =>
					Effect.gen(function* () {
						if (file.endsWith('/checkout') && failRemoval) {
							failRemoval = false
							yield* fs.remove(join(file, '.git'), { recursive: true })
							return yield* PlatformError.systemError({
								_tag: 'PermissionDenied',
								module: 'FileSystem',
								method: 'remove',
							})
						}
						return yield* fs.remove(file, options)
					}),
			}),
		})
		await f.call((service) => service.prepare(f.input))
		await writeFile(join(f.checkout, 'precious.txt'), 'recover me\n')
		const archived = await f.call((service) => service.archive(f.input))
		if (archived._tag !== 'Archived') throw new Error('Expected Archived')
		const archiveBytes = await readFile(archived.archive.path)
		expect(await f.error((service) => service.release(taskId))).toMatchObject({ code: 'io_failed' })
		expect(await f.call((service) => service.inspect(taskId))).toMatchObject({ _tag: 'Releasing' })
		expect(await readFile(join(f.checkout, 'precious.txt'), 'utf8')).toBe('recover me\n')
		expect(await f.call((service) => service.release(taskId))).toMatchObject({ _tag: 'Released' })
		expect(await readFile(archived.archive.path)).toEqual(archiveBytes)
	})

	it('uses a kernel lock that rejects a parallel helper and is reusable after the holder exits', async () => {
		const f = await fixture()
		await mkdir(f.root)
		const holder = spawn(
			'flock',
			[
				'--exclusive',
				'--no-fork',
				join(f.root, '.workspace.lock'),
				process.execPath,
				'-e',
				'process.stdout.write("locked\\n");setInterval(()=>{},1000)',
			],
			{ env: f.environment, stdio: ['ignore', 'pipe', 'ignore'] },
		)
		onTestFinished(() => {
			holder.kill('SIGKILL')
		})
		await new Promise<void>((resolve, reject) => {
			holder.stdout.once('data', () => resolve())
			holder.once('error', reject)
		})
		expect(await f.error((service) => service.prepare(f.input))).toMatchObject({ code: 'busy' })
		const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()))
		holder.kill('SIGKILL')
		await exited
		expect(await f.call((service) => service.prepare(f.input))).toMatchObject({ _tag: 'Ready' })
	})
})
