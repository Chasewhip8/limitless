import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { Effect, Redacted } from 'effect'
import { describe, expect, it } from 'vitest'
import { commandEnvironmentVariable } from '../src/source/native'
import { SourceError } from '../src/source/schema'
import {
	bundleProgram,
	executable,
	execute,
	type SourceFixture,
	sourceFixture,
} from './fixtures/source'

const waitForLock = async (f: SourceFixture) => {
	const node = await executable('node')
	await execute('flock', ['--exclusive', f.idLock, node, '-e', 'process.exit(0)'], {
		timeout: 10_000,
	})
}

const identity = async (file: string) => {
	const info = await stat(file)
	return `${info.dev}:${info.ino}`
}

/**
 * Descriptors `pid` holds on the source lock, matched by device and inode rather than path so the
 * check also holds across mount namespaces.
 */
const lockDescriptors = async (f: SourceFixture, pid: number | undefined) => {
	const lock = await identity(f.idLock)
	const descriptors = await readdir(`/proc/${pid}/fd`)
	const held = await Promise.all(
		descriptors.map((fd) => identity(`/proc/${pid}/fd/${fd}`).catch(() => '')),
	)
	return descriptors
		.filter((_, index) => held[index] === lock)
		.map(Number)
		.sort((left, right) => left - right)
}

const parentOf = async (pid: number) => {
	const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
	return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
}

async function holdLock(f: SourceFixture, file: string) {
	const holder = spawn(
		'flock',
		[
			'--exclusive',
			file,
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
	return async () => {
		holder.stdin.end()
		await exited
	}
}

type Runtime = 'node' | 'bun'

/**
 * Prepares in a separate `runtime` process whose checkout blocks in a Git smudge filter until
 * released. Each command's Node trampoline and the writers always run on `node`.
 */
async function blockedGitHelper(f: SourceFixture, runtime: Runtime) {
	const node = await executable('node')
	const socketPath = join(f.directory, 'writer-socket')
	const server = createServer()
	f.cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
	server.listen(socketPath)
	await once(server, 'listening')
	const writerFile = join(f.directory, 'smudge-writer')
	const lateWork = join(f.staging, 'surviving-writer.txt')
	await writeFile(
		writerFile,
		`#!${node}
const fs = require('node:fs');
const net = require('node:net');
const client = net.connect(${JSON.stringify(socketPath)});
process.stdin.resume();
client.on('connect', () => client.write(JSON.stringify({
 pid: process.pid, parent: process.ppid,
 flags: fs.readFileSync('/proc/'+process.ppid+'/fdinfo/3', 'utf8')
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
		f.environment.GIT_CONFIG_GLOBAL ?? '',
		`[core]\n\tattributesFile = ${attributes}\n[filter "blocking"]\n\tsmudge = ${writerFile}\n\trequired = true\n`,
	)
	const bundle = await bundleProgram(
		f,
		'prepare',
		`
const abort = new AbortController();
process.stdin.once('data', () => abort.abort());
const program = Effect.gen(function* () {
 const service = yield* make(options);
 return yield* service.prepare(request);
}).pipe(Effect.provide(NodeServices.layer));
Effect.runPromise(program, {signal: abort.signal}).then(() => process.exit(0), () => process.exit(abort.signal.aborted ? 0 : 1));
`,
	)
	const helper = spawn(await executable(runtime), [bundle], {
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
			throw new Error('Source helper exited before its writer became active.')
		}),
	])
	f.cleanup.push(async () => {
		if (!socket.destroyed) socket.end('finish\n')
		await waitForLock(f)
		socket.destroy()
	})
	const [ready] = await Promise.race([
		once(socket, 'data'),
		exited.then(() => {
			throw new Error('Source writer stopped before reporting its inherited lock.')
		}),
	])
	const writer: { pid: number; parent: number; flags: string } = JSON.parse(ready.toString())
	return { helper, exited, socket, writer, lateWork }
}

/**
 * Archives in a separate `runtime` process that pauses before writing the Archived manifest, after
 * its archive commands have finished.
 */
async function pausedArchiveHelper(f: SourceFixture, runtime: Runtime) {
	const socketPath = join(f.directory, 'paused-socket')
	const server = createServer()
	f.cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
	server.listen(socketPath)
	await once(server, 'listening')
	const bundle = await bundleProgram(
		f,
		'archive',
		`
import fsNative from 'node:fs';
import net from 'node:net';
const client = net.connect(${JSON.stringify(socketPath)});
client.on('error', () => process.exit(1));
const program = Effect.gen(function* () {
 const fs = yield* FileSystem.FileSystem;
 const permit = yield* Deferred.make();
 client.once('data', () => Effect.runFork(Deferred.succeed(permit, undefined)));
 let writes = 0;
 const guarded = {...fs, open: (path, openOptions) => Effect.gen(function* () {
  if (path.endsWith('.manifest.next') && ++writes === 2) {
   if (!(yield* Deferred.isDone(permit))) {
    const children = fsNative.readFileSync('/proc/self/task/'+process.pid+'/children', 'utf8').trim().split(' ').filter(Boolean).map(Number);
    client.write(JSON.stringify({children})+'\\n');
   }
   yield* Deferred.await(permit);
  }
  return yield* fs.open(path, openOptions);
 })};
 const service = yield* make(options).pipe(Effect.provideService(FileSystem.FileSystem, guarded));
 return yield* service.archive(request);
}).pipe(Effect.provide(NodeServices.layer));
const finish = () => client.end('finished\\n', () => process.exit(0));
Effect.runPromise(program).then(finish, finish);
`,
	)
	const helper = spawn(await executable(runtime), [bundle], {
		cwd: f.directory,
		env: f.environment,
		stdio: ['ignore', 'ignore', 'ignore'],
	})
	const exited = once(helper, 'exit')
	f.cleanup.push(async () => {
		if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL')
		await exited
		await waitForLock(f)
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

describe('source locks', () => {
	it.each<Runtime>([
		'node',
		'bun',
	])('keeps the kernel lock across a %s helper SIGKILL until the real Git descendant finishes writing', async (runtime) => {
		const f = await sourceFixture()
		const active = await blockedGitHelper(f, runtime)
		const trampoline = await parentOf(active.writer.parent)
		expect(await lockDescriptors(f, active.helper.pid)).toHaveLength(1)
		expect(await lockDescriptors(f, trampoline)).toEqual([0])
		expect(await lockDescriptors(f, active.writer.parent)).toEqual([3])
		expect(await lockDescriptors(f, active.writer.pid)).toEqual([3])
		const flags = active.writer.flags.match(/^flags:\s+([0-7]+)$/m)?.[1]
		if (flags === undefined) throw new Error('Writer did not report descriptor flags.')
		expect(Number.parseInt(flags, 8) & 0o2000000).toBe(0)
		const before = await readFile(f.manifest, 'utf8')
		active.helper.kill('SIGKILL')
		expect(await active.exited).toEqual([null, 'SIGKILL'])
		process.kill(active.writer.pid, 0)
		process.kill(active.writer.parent, 0)
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({ code: 'busy' })
		expect(await f.error((service) => service.archive(f.request))).toMatchObject({ code: 'busy' })
		expect(await f.error((service) => service.release(f.request.id))).toMatchObject({
			code: 'busy',
		})
		expect(await readFile(f.manifest, 'utf8')).toBe(before)
		active.socket.write('finish\n')
		await once(active.socket, 'end')
		await waitForLock(f)
		expect(await readFile(active.lateWork, 'utf8')).toBe('written after helper death\n')
		const archived = await f.call((service) => service.archive(f.request))
		if (archived._tag !== 'Archived') throw new Error('Expected Archived')
		const { stdout } = await execute('tar', [
			'--extract',
			'--to-stdout',
			'--file',
			archived.archive.path,
			'staging/surviving-writer.txt',
		])
		expect(stdout).toBe('written after helper death\n')
	}, 30_000)

	it.each<Runtime>([
		'node',
		'bun',
	])('cancels the supervised Git process group from a %s helper before allowing another source operation', async (runtime) => {
		const f = await sourceFixture()
		const active = await blockedGitHelper(f, runtime)
		const writerClosed = once(active.socket, 'close')
		active.helper.stdin?.write('cancel\n')
		await active.exited
		await writerClosed
		await waitForLock(f)
		await expect(stat(active.lateWork)).rejects.toMatchObject({ code: 'ENOENT' })
		expect(await f.call((service) => service.archive(f.request))).toMatchObject({
			_tag: 'Archived',
		})
	}, 30_000)

	it.each<Runtime>([
		'node',
		'bun',
	])('holds the lock in a %s parent between commands without any child process', async (runtime) => {
		const f = await sourceFixture()
		const active = await pausedArchiveHelper(f, runtime)
		expect(active.paused.children).toEqual([])
		expect(await lockDescriptors(f, active.helper.pid)).toHaveLength(1)
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({ code: 'busy' })
		expect(await f.error((service) => service.release(f.request.id))).toMatchObject({
			code: 'busy',
		})
		expect(JSON.parse(await readFile(f.manifest, 'utf8'))).toMatchObject({
			status: { _tag: 'Archiving' },
		})
		active.socket.write('continue\n')
		expect(await active.exited).toEqual([0, null])
		expect(await f.call((service) => service.inspect(f.request.id))).toMatchObject({
			_tag: 'Archived',
		})
	}, 30_000)

	it.each<Runtime>([
		'node',
		'bun',
	])('keeps a %s parent locked and stops its operation after the active trampoline is killed', async (runtime) => {
		const f = await sourceFixture()
		const active = await blockedGitHelper(f, runtime)
		const trampoline = await parentOf(active.writer.parent)
		expect(await parentOf(trampoline)).toBe(active.helper.pid)
		const before = await readFile(f.manifest, 'utf8')
		process.kill(trampoline, 'SIGKILL')
		await expect.poll(() => parentOf(trampoline).catch(() => undefined)).toBeUndefined()
		process.kill(active.writer.pid, 0)
		expect(await lockDescriptors(f, active.helper.pid)).toHaveLength(1)
		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({ code: 'busy' })
		expect(await f.error((service) => service.archive(f.request))).toMatchObject({ code: 'busy' })
		active.socket.write('finish\n')
		expect(await active.exited).toEqual([1, null])
		await waitForLock(f)
		expect(await readFile(active.lateWork, 'utf8')).toBe('written after helper death\n')
		expect(await readFile(f.manifest, 'utf8')).toBe(before)
		expect(await f.call((service) => service.inspect(f.request.id))).toMatchObject({
			_tag: 'Preparing',
			step: 'clone',
		})
	}, 30_000)

	it.each<Runtime>([
		'node',
		'bun',
	])('stops the surviving writers of a killed trampoline when its %s parent is interrupted', async (runtime) => {
		const f = await sourceFixture()
		const active = await blockedGitHelper(f, runtime)
		const git = active.writer.parent
		const trampoline = await parentOf(git)
		expect(await parentOf(trampoline)).toBe(active.helper.pid)
		const writerClosed = once(active.socket, 'close')
		process.kill(trampoline, 'SIGKILL')
		await expect.poll(() => parentOf(trampoline).catch(() => undefined)).toBeUndefined()
		expect(active.helper.exitCode).toBeNull()
		process.kill(active.writer.pid, 0)

		active.helper.stdin?.write('cancel\n')
		expect(await active.exited).toEqual([0, null])
		await writerClosed
		for (const pid of [git, active.writer.pid])
			await expect.poll(() => parentOf(pid).catch(() => undefined)).toBeUndefined()
		await waitForLock(f)
		await expect(stat(active.lateWork)).rejects.toMatchObject({ code: 'ENOENT' })
		expect(await f.call((service) => service.inspect(f.request.id))).toMatchObject({
			_tag: 'Preparing',
			step: 'clone',
		})
	}, 30_000)

	it('excludes the same id while other ids proceed, with only per-id locks outside sources', async () => {
		const f = await sourceFixture()
		await mkdir(join(f.root, '.locks'), { recursive: true, mode: 0o700 })
		await writeFile(f.idLock, '')
		const releaseId = await holdLock(f, f.idLock)
		expect(await f.error((service) => service.inspect(f.request.id))).toMatchObject({
			code: 'busy',
		})
		const other = await f.call((service) => service.prepare({ ...f.request, id: 'other-source' }))
		expect(other).toMatchObject({ directory: join(f.root, 'other-source', 'checkout') })
		await releaseId()

		expect(await f.call((service) => service.prepare(f.request))).toMatchObject({
			commit: f.headSha,
		})
		expect((await stat(f.idLock)).isFile()).toBe(true)
		expect((await readdir(f.root)).sort()).toEqual(['.locks', 'fixture-source', 'other-source'])
	}, 30_000)

	it.each<Runtime>([
		'node',
		'bun',
	])('reports %s spawn failures as io_failed and keeps owned lock descriptors through collection', async (runtime) => {
		const f = await sourceFixture()
		const missing = join(f.directory, 'missing-executable')
		const bundle = await bundleProgram(
			f,
			'spawn-failures',
			`
import fsNative from 'node:fs';
const lock = ${JSON.stringify(f.idLock)};
const collect = () => globalThis.Bun?.gc(true);
const held = () => fsNative.readdirSync('/proc/self/fd').map((fd) => { try { return fsNative.readlinkSync('/proc/self/fd/' + fd) } catch { return '' } });
const lost = [];
const command = (input) => Effect.sync(() => {
 collect();
 const open = held();
 if (!open.includes(lock)) lost.push(input.args.find((arg) => !arg.startsWith('-') && !arg.includes('=')));
 return input;
});
const attempt = (overrides) => Effect.gen(function* () {
 const service = yield* make({ ...options, command, ...overrides });
 return yield* service.prepare(request);
}).pipe(Effect.match({ onFailure: (error) => error.code, onSuccess: (prepared) => prepared.commit }), Effect.provide(NodeServices.layer));
const results = [];
for (const overrides of [{ flock: ${JSON.stringify(missing)} }, { node: ${JSON.stringify(missing)} }, {}, {}])
 results.push(await Effect.runPromise(attempt(overrides)));
const unrelated = fsNative.openSync(${JSON.stringify(join(f.directory, 'unrelated'))}, 'w');
for (let index = 0; index < 5; index++) { collect(); await new Promise((resolve) => setTimeout(resolve, 20)); }
let unrelatedOpen = true;
try { fsNative.fstatSync(unrelated) } catch { unrelatedOpen = false }
process.stdout.write(JSON.stringify({ results, lost, unrelatedOpen, leaked: held().filter((file) => file === lock) }));
`,
		)
		const { stdout } = await execute(await executable(runtime), [bundle], {
			cwd: f.directory,
			env: f.environment,
		})
		expect(JSON.parse(stdout)).toEqual({
			results: ['io_failed', 'io_failed', f.headSha, f.headSha],
			lost: [],
			unrelatedOpen: true,
			leaked: [],
		})
		await waitForLock(f)
	}, 30_000)

	it('reclaims the native child objects of repeated Bun operations', async () => {
		const f = await sourceFixture()
		const bundle = await bundleProgram(
			f,
			'reclamation',
			`
const { heapStats } = await import(['bun', 'jsc'].join(':'));
const service = await Effect.runPromise(make(options).pipe(Effect.provide(NodeServices.layer)));
const prepare = () => Effect.runPromise(service.prepare(request).pipe(Effect.provide(NodeServices.layer)));
const collect = async () => {
 for (let index = 0; index < 5; index++) { Bun.gc(true); await new Promise((resolve) => setTimeout(resolve, 20)); }
 return heapStats().objectTypeCounts.Subprocess ?? 0;
};
for (let index = 0; index < 10; index++) await prepare();
const counts = [await collect()];
for (let batch = 0; batch < 4; batch++) {
 for (let index = 0; index < 25; index++) await prepare();
 counts.push(await collect());
}
process.stdout.write(JSON.stringify(counts));
`,
		)
		const { stdout } = await execute(await executable('bun'), [bundle], {
			cwd: f.directory,
			env: f.environment,
		})
		const counts: Array<number> = JSON.parse(stdout)
		expect(counts).toHaveLength(5)
		// Each operation starts several children; retaining them would leave hundreds after 100.
		for (const count of counts) expect(count).toBeLessThanOrEqual(10)
	}, 60_000)

	it('runs every command through the effectful hook with the lock, fresh credentials, and only its own environment', async () => {
		const scratch = await mkdtemp('/tmp/opencode/source-hook-')
		const log = join(scratch, 'commands.log')
		const token = join(scratch, 'token')
		const wrapper = join(scratch, 'wrapper.sh')
		await writeFile(
			wrapper,
			[
				'#!/bin/sh',
				'if grep -qF "$SOURCE_TOKEN" /proc/$PPID/cmdline; then argv=leak; else argv=clean; fi',
				"if tr '\\0' '\\n' < /proc/$PPID/environ | grep -q '^NODE_OPTIONS='; then helper=affected; else helper=clean; fi",
				`printf '%s|%s|%s|%s|%s|%s|%s|%s\\n' "$(stat -L -c %d:%i /proc/$$/fd/3)" "$SOURCE_TOKEN" "$argv" "$helper" "\${NODE_OPTIONS-unset}" "\${${commandEnvironmentVariable}-unset}" "\${SOURCE_FIXTURE_EMPTY-unset}" "\${SOURCE_FIXTURE_BASE-unset}" >> ${log}`,
				'exec "$@"',
				'',
			].join('\n'),
			{ mode: 0o755 },
		)
		const nodeOptions = '--require /missing-target-only-module'
		const f = await sourceFixture({
			command: (command) =>
				Effect.gen(function* () {
					const secret = yield* Effect.tryPromise({
						try: () => readFile(token, 'utf8'),
						catch: () =>
							SourceError.make({ code: 'io_failed', message: 'The fixture token is unavailable.' }),
					})
					const collision =
						secret.trim() === 'rotated-token'
							? { [commandEnvironmentVariable]: 'target-original' }
							: {}
					return {
						...command,
						executable: wrapper,
						args: [command.executable, ...command.args],
						env: {
							...command.env,
							SOURCE_TOKEN: Redacted.make(secret.trim()),
							NODE_OPTIONS: nodeOptions,
							SOURCE_FIXTURE_EMPTY: '',
							SOURCE_FIXTURE_BASE: null,
							...collision,
						},
					}
				}),
		})
		f.cleanup.push(() => rm(scratch, { recursive: true, force: true }))
		const records = async () => {
			const lines = (await readFile(log, 'utf8')).trim().split('\n')
			await rm(log)
			return lines.map((line) => line.split('|'))
		}
		const expected = (lock: string, secret: string, transport: string) => [
			lock,
			secret,
			'clean',
			'clean',
			nodeOptions,
			transport,
			'',
			'unset',
		]

		expect(await f.error((service) => service.prepare(f.request))).toMatchObject({
			code: 'io_failed',
			message: 'The fixture token is unavailable.',
		})
		await expect(stat(f.manifest)).rejects.toMatchObject({ code: 'ENOENT' })

		await writeFile(token, 'first-token\n')
		expect(await f.call((service) => service.prepare(f.request))).toMatchObject({
			commit: f.headSha,
		})
		const lock = await identity(f.idLock)
		const first = await records()
		expect(first.length).toBeGreaterThan(3)
		for (const command of first) expect(command).toEqual(expected(lock, 'first-token', 'unset'))

		await writeFile(token, 'rotated-token\n')
		expect(await f.call((service) => service.prepare(f.request))).toMatchObject({
			commit: f.headSha,
		})
		for (const command of await records())
			expect(command).toEqual(expected(lock, 'rotated-token', 'target-original'))
	}, 30_000)

	it('refuses a command environment beyond the transport limit without reporting it, then recovers', async () => {
		let large = true
		const f = await sourceFixture({
			command: (command) =>
				Effect.succeed({
					...command,
					env: large
						? { ...command.env, SOURCE_FIXTURE_LARGE: 'x'.repeat(125 * 1024) }
						: command.env,
				}),
		})
		const refused = await f.error((service) => service.prepare(f.request))
		expect(refused).toMatchObject({
			code: 'io_failed',
			message: 'The source command environment exceeds the supported size.',
		})
		expect(JSON.stringify(refused)).not.toContain('xxxx')
		await expect(stat(f.manifest)).rejects.toMatchObject({ code: 'ENOENT' })
		large = false
		expect(await f.call((service) => service.prepare(f.request))).toMatchObject({
			commit: f.headSha,
		})
	}, 30_000)
})
