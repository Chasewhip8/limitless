import { Effect, Option, Predicate, Schema } from 'effect'
import { CapsuleError, type Manifest } from '../schema'
import type { Capsule } from '../service'
import { SourceError, SourceRequest } from '../source/schema'
import { matchesBinding } from '../workspace/binding'
import { FailureCode, type HostInfo, Owner, PrepareSession, SessionReference } from './contract'
import type { NativePorts, NativeSession, NativeWorkspace } from './native'
import { resolveSettings, storageIdOf } from './roots'
import type { HostSettings } from './settings'

export class HostRejected extends Schema.TaggedError<HostRejected>()('CapsuleHostRejected', {
	code: FailureCode,
	message: Schema.String,
}) {}

const provider = 'capsule'
// The session metadata key the host owns; it records who prepared the session and for which agent.
const reservedKey = 'capsule'
const Marker = Schema.Struct({ owner: Owner, agent: Schema.NonEmptyString })
const resumablePhases: ReadonlyArray<Manifest['phase']> = ['creating', 'preparing', 'ready']

const equivalentOwner = Schema.toEquivalence(Owner)
const equivalentSource = Schema.toEquivalence(SourceRequest)

const reject = (code: FailureCode, message: string) => HostRejected.make({ code, message })

const capsuleCodes: Record<CapsuleError['code'], FailureCode> = {
	invalid_input: 'invalid_input',
	unsafe_path: 'incompatible',
	ownership_mismatch: 'ownership',
	not_prepared: 'not_ready',
	bootstrap_failed: 'unavailable',
	command_failed: 'unavailable',
	environment_failed: 'unavailable',
}

const sourceCodes: Record<SourceError['code'], FailureCode> = {
	invalid_input: 'invalid_input',
	input_collision: 'ownership',
	illegal_transition: 'not_ready',
	unsafe_path: 'incompatible',
	ownership_mismatch: 'ownership',
	busy: 'unavailable',
	unknown_ref: 'invalid_input',
	stale_ref: 'invalid_input',
	git_failed: 'unavailable',
	archive_failed: 'unavailable',
	archive_changed: 'unavailable',
	io_failed: 'unavailable',
	invalid_manifest: 'incompatible',
}

// Capsule and source errors carry only authored messages; anything else, such as a held lock or a
// platform failure, is reported as retryable without its details.
const fromCapsule = (error: unknown) => {
	if (error instanceof CapsuleError) return reject(capsuleCodes[error.code], error.message)
	if (error instanceof SourceError) return reject(sourceCodes[error.code], error.message)
	return reject('unavailable', 'Capsule is busy or unavailable; retry the request.')
}

const tagOf = (error: unknown) =>
	Predicate.hasProperty(error, '_tag') && Predicate.isString(error._tag) ? error._tag : 'unknown'

const sameSource = (manifest: Manifest, request: PrepareSession) =>
	manifest.source !== undefined &&
	equivalentSource(manifest.source.request, { ...request.source, id: request.workspaceId })

const prepared = (reference: SessionReference, manifest: Manifest) => ({
	workspaceId: reference.workspaceId,
	sessionId: reference.sessionId,
	directory: manifest.spec.directory,
})

/**
 * Prepares and proves Capsule-backed native sessions. Build `capsule` from the same settings,
 * resolved with `resolveSettings`, and register its workspace driver as the `capsule` provider.
 */
export const make = Effect.fn('CapsuleHost.make')(function* (
	input: HostSettings,
	capsule: Capsule['Service'],
	native: NativePorts,
) {
	const settings = yield* resolveSettings(input)
	if (
		settings.root !== input.root ||
		settings.checkoutRoot !== input.checkoutRoot ||
		settings.controlDirectory !== input.controlDirectory
	) {
		return yield* CapsuleError.make({
			code: 'unsafe_path',
			message: 'Resolve the Capsule host settings before building its Capsule.',
		})
	}
	const info: HostInfo = {
		version: 1,
		storageId: storageIdOf(settings),
		checkoutRoot: settings.checkoutRoot,
	}

	const call = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
		effect.pipe(
			Effect.tapError((error) =>
				Effect.logWarning('Capsule host native call failed', { operation, error: tagOf(error) }),
			),
			Effect.mapError(() => reject('unavailable', 'OpenCode is unavailable; retry the request.')),
		)

	const checkStorage = Effect.fn('CapsuleHost.checkStorage')(function* (storageId: string) {
		if (storageId !== info.storageId) {
			return yield* reject('incompatible', 'The request names another Capsule storage.')
		}
	})

	const checkProvider = Effect.fn('CapsuleHost.checkProvider')(function* (
		workspace: NativeWorkspace,
	) {
		if (workspace.provider !== provider) {
			return yield* reject('ownership', 'The workspace belongs to another provider.')
		}
		return workspace
	})

	const checkManaged = Effect.fn('CapsuleHost.checkManaged')(function* (manifest: Manifest) {
		if (!manifest.source) {
			return yield* reject('ownership', 'The Capsule does not hold a managed source.')
		}
		if (manifest.source.root !== settings.checkoutRoot) {
			return yield* reject('incompatible', 'The Capsule belongs to another checkout root.')
		}
	})

	const checkSession = Effect.fn('CapsuleHost.checkSession')(function* (
		session: NativeSession,
		reference: SessionReference,
	) {
		const marker = Option.getOrUndefined(
			Schema.decodeUnknownOption(Marker)(session.metadata?.[reservedKey]),
		)
		if (
			!marker ||
			!equivalentOwner(marker.owner, reference.owner) ||
			session.id !== reference.sessionId ||
			session.location.workspaceID !== reference.workspaceId ||
			session.parentID !== undefined ||
			session.fork !== undefined
		) {
			return yield* reject('ownership', 'The session belongs to another workspace or owner.')
		}
		return marker
	})

	const readSession = (id: string) => call('session lookup', native.sessions.get(id))
	const lookupWorkspace = (id: string) => call('workspace lookup', native.workspaces.get(id))
	const inspectCapsule = (id: string) => capsule.inspect(id).pipe(Effect.mapError(fromCapsule))

	const workspaceStateOf = Effect.fn('CapsuleHost.workspaceStateOf')(function* (
		workspace: NativeWorkspace | undefined,
		manifest: Manifest,
	) {
		if (!workspace) return 'absent' as const
		if (workspace.id !== manifest.spec.id) {
			return yield* reject('ownership', 'The workspace belongs to another Capsule.')
		}
		yield* checkProvider(workspace)
		if (workspace.binding === null) return 'unprovisioned' as const
		if (!matchesBinding(workspace.binding, manifest)) {
			return yield* reject('ownership', 'The workspace is bound to another Capsule checkout.')
		}
		return 'bound' as const
	})

	// Proves without side effects that the session belongs to its retained Capsule, and observes
	// the Capsule's phase and workspace state without requiring either to be ready. The manifest,
	// including a purged tombstone, is the only proof of ownership; a missing one is never rebuilt.
	const observe = Effect.fn('CapsuleHost.observe')(function* (
		session: NativeSession,
		reference: SessionReference,
	) {
		const marker = yield* checkSession(session, reference)
		const manifest = yield* inspectCapsule(reference.workspaceId)
		if (!manifest) return yield* reject('ownership', 'The session has no Capsule record.')
		yield* checkManaged(manifest)
		if (session.location.directory !== manifest.spec.directory) {
			return yield* reject('ownership', 'The session is not placed in its Capsule checkout.')
		}
		const workspace = yield* lookupWorkspace(reference.workspaceId)
		const workspaceState = yield* workspaceStateOf(workspace, manifest)
		return { marker, manifest, workspaceState }
	})

	// A prepare retry succeeds only while its session can still run; it never resumes the Capsule.
	const confirm = Effect.fn('CapsuleHost.confirm')(function* (
		session: NativeSession,
		request: PrepareSession,
	) {
		const { marker, manifest, workspaceState } = yield* observe(session, request)
		if (marker.agent !== request.agent || !sameSource(manifest, request)) {
			return yield* reject('ownership', 'The session was prepared for another source or agent.')
		}
		if (manifest.phase !== 'ready' || workspaceState !== 'bound') {
			return yield* reject('not_ready', 'The Capsule workspace is not ready.')
		}
		return prepared(request, manifest)
	})

	// Refuses known conflicts before claiming a workspace; create rechecks lifecycle policy under
	// its exclusive lock.
	const checkReusable = Effect.fn('CapsuleHost.checkReusable')(function* (request: PrepareSession) {
		const manifest = yield* inspectCapsule(request.workspaceId)
		if (!manifest) return
		if (!resumablePhases.includes(manifest.phase)) {
			return yield* reject('not_ready', 'The Capsule was stopped or purged.')
		}
		yield* checkManaged(manifest)
		if (!sameSource(manifest, request)) {
			return yield* reject('ownership', 'The workspace is reserved for another source.')
		}
	})

	// The logical workspace exists before its Capsule, so OpenCode can destroy a partial one.
	const claimWorkspace = Effect.fn('CapsuleHost.claimWorkspace')(function* (id: string) {
		const existing = yield* lookupWorkspace(id)
		if (existing) return yield* checkProvider(existing)
		yield* call('workspace create', native.workspaces.create({ id, provider })).pipe(
			Effect.catch((rejected) =>
				Effect.gen(function* () {
					const raced = yield* lookupWorkspace(id)
					if (raced) return yield* checkProvider(raced)
					return yield* rejected
				}),
			),
		)
	})

	const provision = Effect.fn('CapsuleHost.provision')(function* (id: string, manifest: Manifest) {
		const workspace = yield* call('workspace provision', native.workspaces.provision(id))
		if (
			workspace.id !== id ||
			workspace.provider !== provider ||
			!matchesBinding(workspace.binding, manifest)
		) {
			return yield* reject('ownership', 'The provisioned workspace does not match its Capsule.')
		}
	})

	// OpenCode adopts an existing session ID before checking its input, so the caller confirms the
	// returned session rather than trusting it.
	const createSession = Effect.fn('CapsuleHost.createSession')(function* (
		request: PrepareSession,
		manifest: Manifest,
	) {
		const created = native.sessions.create({
			id: request.sessionId,
			location: { directory: manifest.spec.directory, workspaceID: request.workspaceId },
			agent: request.agent,
			metadata: {
				...request.metadata,
				[reservedKey]: { owner: request.owner, agent: request.agent },
			},
		})
		return yield* call('session create', created).pipe(
			Effect.catch((rejected) =>
				Effect.gen(function* () {
					const adopted = yield* readSession(request.sessionId)
					if (adopted) return adopted
					return yield* rejected
				}),
			),
		)
	})

	const prepareSession = Effect.fn('CapsuleHost.prepareSession')(function* (input: PrepareSession) {
		const request = yield* Schema.decodeUnknownEffect(PrepareSession)(input).pipe(
			Effect.mapError(() => reject('invalid_input', 'Invalid Capsule session request.')),
		)
		yield* checkStorage(request.storageId)
		if (request.metadata && reservedKey in request.metadata) {
			return yield* reject('invalid_input', `Session metadata key "${reservedKey}" is reserved.`)
		}
		const existing = yield* readSession(request.sessionId)
		if (existing) return yield* confirm(existing, request)

		yield* checkReusable(request)
		yield* claimWorkspace(request.workspaceId)
		const manifest = yield* capsule
			.create(
				{ ...request.source, id: request.workspaceId },
				{
					allowResume: false,
					...(settings.dockerSocket ? { dockerSocket: settings.dockerSocket } : {}),
				},
			)
			.pipe(Effect.mapError(fromCapsule))
		yield* provision(request.workspaceId, manifest)
		const session = yield* createSession(request, manifest)
		return yield* confirm(session, request)
	})

	const getSession = Effect.fn('CapsuleHost.getSession')(function* (input: SessionReference) {
		const reference = yield* Schema.decodeUnknownEffect(SessionReference)(input).pipe(
			Effect.mapError(() => reject('invalid_input', 'Invalid Capsule session reference.')),
		)
		yield* checkStorage(reference.storageId)
		const session = yield* readSession(reference.sessionId)
		if (!session) return yield* reject('not_ready', 'The session does not exist.')
		const { manifest, workspaceState } = yield* observe(session, reference)
		return { ...prepared(reference, manifest), capsulePhase: manifest.phase, workspaceState }
	})

	return { info, prepareSession, getSession }
})

export type CapsuleHost = Effect.Success<ReturnType<typeof make>>
