import { Effect, Layer, ManagedRuntime, Queue, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { PipelineConfig, type PipelineSettings } from '../config'
import { GitHub } from '../github/service'
import { schedulerLayer } from '../scheduler'
import type { PullRequest, ReviewRequest } from '../tasks/schema'
import { tasksLayer } from '../tasks/service'
import { taskStoreLayer } from '../tasks/store'
import {
	type NativeObservation,
	type SessionIdentity,
	type Worker,
	WorkerError,
} from '../worker/schema'
import { OpenCodeWorker } from '../worker/service'

export const worker: Worker = {
	id: 'pc',
	url: 'https://pc.example.test',
	credentialFile: '/tmp/opencode/test-password',
	workspaceRoot: '/tmp/opencode/pipeline-test-tasks',
	helperExecutable: '/tmp/opencode/pipeline-helper',
	system: 'x86_64-linux',
	capacity: 1,
	openCodeVersion: '2.2.7',
}
export const settings: PipelineSettings = {
	host: '127.0.0.1',
	port: 4848,
	database: '/tmp/opencode/pipeline-test.sqlite',
	apiTokenFile: '/tmp/opencode/test-api-token',
	githubTokenFile: null,
	pollIntervalMs: 60_000,
	queueTimeoutMs: 60_000,
	workers: [worker],
}
export const pullRequest: PullRequest = {
	url: 'https://github.com/test/repo/pull/1',
	repository: 'test/repo',
	sourceRepository: 'test/repo',
	repositoryId: 1,
	sourceRepositoryId: 1,
	number: 1,
	headRef: 'feature',
	headSha: 'a'.repeat(40),
	baseSha: 'b'.repeat(40),
}
export const review = (pr = 1): ReviewRequest => ({
	kind: 'review',
	pr: `https://github.com/test/repo/pull/${pr}`,
})

const unavailable = (message: string) => WorkerError.make({ code: 'unavailable', message })

export function fakeWorker() {
	const calls: Array<{ operation: string; session?: SessionIdentity; messageId?: string }> = []
	const sessions = new Set<string>()
	const inbox = new Map<string, string>()
	const changes = Effect.runSync(Queue.sliding<void>(1))
	const control = {
		readinessCalls: 0,
		readinessNotifies: false,
		unreachable: false,
		observation: { _tag: 'Running', backgroundJobs: 0 } as NativeObservation,
		/** The native write happens, but its reply is lost. */
		loseAdmitReply: false,
		/** The native write never happens and the reply is lost. */
		dropAdmit: false,
		loseInterruptReply: false,
		historyUnavailable: false,
		prepareError: null as WorkerError | null,
	}
	const reachable = Effect.fn('FakeWorker.reachable')(function* () {
		if (control.unreachable) return yield* unavailable('Synthetic partition')
	})
	const remote = OpenCodeWorker.of({
		ready: () =>
			Effect.gen(function* () {
				control.readinessCalls++
				yield* reachable()
				if (control.readinessNotifies) yield* Queue.offer(changes, undefined)
				return undefined
			}),
		prepare: (_worker, assignment, input) =>
			Effect.gen(function* () {
				calls.push({ operation: 'prepare' })
				yield* reachable()
				if (control.prepareError !== null) return yield* control.prepareError
				return { _tag: 'Ready' as const, taskId: input.taskId, directory: assignment.directory }
			}),
		createSession: (_worker, session) =>
			Effect.gen(function* () {
				calls.push({ operation: 'createSession', session })
				yield* reachable()
				sessions.add(session.sessionId)
				return undefined
			}),
		requireSession: (_worker, session) =>
			Effect.gen(function* () {
				calls.push({ operation: 'requireSession', session })
				yield* reachable()
				if (!sessions.has(session.sessionId))
					return yield* WorkerError.make({
						code: 'ownership',
						message: 'Retained native session is missing',
					})
				return undefined
			}),
		admit: (_worker, session, messageId, prompt) =>
			Effect.gen(function* () {
				calls.push({ operation: 'admit', session, messageId })
				yield* reachable()
				if (control.dropAdmit) return yield* unavailable('Synthetic lost request')
				inbox.set(messageId, prompt)
				if (control.loseAdmitReply) return yield* unavailable('Synthetic lost reply')
				return { sessionId: session.sessionId, messageId }
			}),
		findAdmission: (_worker, session, messageId, prompt) =>
			Effect.gen(function* () {
				calls.push({ operation: 'findAdmission', session, messageId })
				yield* reachable()
				if (control.historyUnavailable) return yield* unavailable('Synthetic history outage')
				if (inbox.get(messageId) !== prompt) return undefined
				return { sessionId: session.sessionId, messageId }
			}),
		interrupt: (_worker, session) =>
			Effect.gen(function* () {
				calls.push({ operation: 'interrupt', session })
				yield* reachable()
				if (control.loseInterruptReply) return yield* unavailable('Synthetic lost reply')
				return { sessionId: session.sessionId }
			}),
		observe: (_worker, session, messageId) =>
			Effect.gen(function* () {
				calls.push({
					operation: 'observe',
					session,
					...(messageId === undefined ? {} : { messageId }),
				})
				yield* reachable()
				return control.observation
			}),
		watch: () => Stream.fromQueue(changes).pipe(Stream.map(() => undefined)),
	})
	return { calls, sessions, inbox, control, remote, changes }
}

export function coordinator(overrides: Partial<PipelineSettings> = {}, database = ':memory:') {
	const native = fakeWorker()
	const dependencies = Layer.mergeAll(
		taskStoreLayer(database),
		Layer.succeed(PipelineConfig, { ...settings, ...overrides }),
		Layer.succeed(OpenCodeWorker, native.remote),
		Layer.succeed(GitHub, GitHub.of({ resolve: () => Effect.succeed(pullRequest) })),
		TestClock.layer(),
	)
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(schedulerLayer, tasksLayer).pipe(Layer.provideMerge(dependencies)),
	)
	return { ...native, runtime }
}
