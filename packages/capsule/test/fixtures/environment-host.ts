// Runs under Bun, which embeds Capsule in OpenCode: resolves a project environment repeatedly, as a
// long-lived host does, and after each capture opens descriptors that reuse whatever numbers it
// released, then forces collection. Bun 1.3 closes an extra stdio pipe again when its subprocess is
// collected, which would close those unrelated descriptors.
import { closeSync, fstatSync, openSync } from 'node:fs'
import { NodeServices } from '@effect/platform-node'
import { Cause, Effect, Option, Record, Redacted, Schema } from 'effect'
import { ChildProcessSpawner } from 'effect/process'
import { resolveEnvironment } from '../../src/runtime/environment'
import { RuntimeSettings } from '../../src/schema'

declare const Bun: { readonly version: string; readonly gc: (force: boolean) => void }

const Input = Schema.Struct({
	settings: RuntimeSettings,
	directory: Schema.String,
	rounds: Schema.Int,
})
const input = Schema.decodeUnknownSync(Schema.fromJsonString(Input))(process.argv[2])

const isOpen = (fd: number) => {
	try {
		fstatSync(fd)
		return true
	} catch {
		return false
	}
}

const collect = Effect.gen(function* () {
	for (let pass = 0; pass < 2; pass++) {
		Bun.gc(true)
		yield* Effect.sleep('20 millis')
	}
})

const round = Effect.gen(function* () {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const environment = yield* resolveEnvironment(spawner, input.settings, {
		id: 'alpha',
		directory: input.directory,
		project: {},
	})
	const unrelated = Array.from({ length: 8 }, () => openSync('/dev/null', 'r'))
	yield* collect
	const closed = unrelated.filter((fd) => !isOpen(fd))
	for (const fd of unrelated) if (!closed.includes(fd)) closeSync(fd)
	const variable = (name: string) =>
		Option.getOrNull(Option.map(Record.get(environment, name), Redacted.value))
	return {
		project: variable('FIXTURE_PROJECT'),
		path: variable('PATH'),
		names: Object.keys(environment).sort(),
		closed: closed.length,
	}
}).pipe(
	Effect.timeout('10 seconds'),
	Effect.catchCause((cause) => Effect.succeed({ failure: Cause.pretty(cause).slice(0, 2_000) })),
)

const rounds = await Effect.runPromise(
	Effect.forEach(Array.from({ length: input.rounds }), () => round).pipe(
		Effect.provide(NodeServices.layer),
	),
)
process.stdout.write(`${JSON.stringify({ bun: Bun.version, rounds })}\n`)
