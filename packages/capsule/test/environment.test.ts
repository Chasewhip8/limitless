import { fileURLToPath } from 'node:url'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Path, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { runBunFixture } from './fixtures/bun'

const fixture = fileURLToPath(new URL('./fixtures/environment-host.ts', import.meta.url))
const rounds = 30
const project = 'line one\nline=two'

// Stands in for `nix develop … --command …`: exports the project variable, writes shell-hook noise
// to stdout and stderr, and runs the capture command.
const fakeNix = `#!/bin/sh
while [ "$#" -gt 0 ]; do
	if [ "$1" = --command ]; then shift; break; fi
	shift
done
FIXTURE_PROJECT='${project}'
export FIXTURE_PROJECT
printf 'shell hook noise\\nNOISE=stdout\\0\\n'
printf 'stderr noise\\n' >&2
exec "$@"
`

const Report = Schema.Struct({
	bun: Schema.String,
	rounds: Schema.Array(
		Schema.Union([
			Schema.Struct({
				project: Schema.NullOr(Schema.String),
				path: Schema.NullOr(Schema.String),
				names: Schema.Array(Schema.String),
				closed: Schema.Number,
			}),
			Schema.Struct({ failure: Schema.String }),
		]),
	),
})

const resolveRepeatedly = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	yield* fs.makeDirectory('/tmp/opencode', { recursive: true })
	const temporary = yield* fs.makeTempDirectoryScoped({
		directory: '/tmp/opencode',
		prefix: 'capsule-env-',
	})
	const base = yield* fs.realPath(temporary)
	const nix = path.join(base, 'nix')
	yield* fs.writeFileString(nix, fakeNix)
	yield* fs.chmod(nix, 0o755)
	const directory = path.join(base, 'checkout')
	yield* fs.makeDirectory(directory)

	const PATH = process.env.PATH ?? ''
	const env = yield* Effect.findFirst(
		PATH.split(':').map((entry) => path.join(entry, 'env')),
		(candidate) => fs.exists(candidate),
	)
	if (env._tag === 'None') return yield* Effect.die('No env executable on PATH')
	// Only the shell, Nix, and env settings take part in resolving an environment.
	const settings = {
		bwrap: '/unused',
		nix,
		shell: '/bin/sh',
		env: env.value,
		node: '/unused',
		gh: '/unused',
		flock: '/unused',
		basePath: PATH,
		certificates: '/unused',
	}
	const stdout = yield* runBunFixture(
		fixture,
		{ settings, directory, rounds },
		{ env: { PATH, HOME: base, TMPDIR: base }, deadline: 45_000 },
	)
	return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Report))(stdout.trim())
})

describe('project environment capture', () => {
	it('leaves the Bun host’s unrelated descriptors open and captures only the environment', async () => {
		const report = await Effect.runPromise(
			resolveRepeatedly.pipe(
				Effect.timeout('50 seconds'),
				Effect.scoped,
				Effect.provide(NodeServices.layer),
			),
		)
		expect(report.rounds).toHaveLength(rounds)
		for (const round of report.rounds) {
			expect(round).toEqual({
				project,
				path: process.env.PATH,
				names: expect.not.arrayContaining(['NOISE']),
				closed: 0,
			})
		}
	}, 60_000)
})
