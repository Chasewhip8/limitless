import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { Effect, Option, Semaphore } from 'effect'
import { imageSize } from 'image-size'
import type { SlackImageMime } from './schema'

const MAX_SLACK_IMAGE_DIMENSION = 10_000
const MAX_SLACK_IMAGE_PIXELS = 25_000_000
const SLACK_IMAGE_VALIDATION_TIMEOUT_MS = 10_000
let imageValidationSemaphore: Semaphore.Semaphore | undefined

function validationSemaphore(): Semaphore.Semaphore {
	imageValidationSemaphore ??= Semaphore.makeUnsafe(1)
	return imageValidationSemaphore
}

function photonWasmPath(): string {
	try {
		return createRequire(import.meta.url).resolve('@silvia-odwyer/photon-node/photon_rs_bg.wasm')
	} catch {
		return fileURLToPath(new URL('photon_rs_bg.wasm', import.meta.url))
	}
}

function runImageWorker(bytes: Uint8Array, signal: AbortSignal): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const transferred = bytes.slice().buffer
		const worker = new Worker(
			import.meta.url.endsWith('.ts')
				? new URL('./image-worker.ts', import.meta.url)
				: new URL('./slack-image-worker.mjs', import.meta.url),
			{
				workerData: { wasmPath: photonWasmPath(), bytes: transferred },
				transferList: [transferred],
				resourceLimits: { maxOldGenerationSizeMb: 128 },
			},
		)
		let settled = false
		const timeout = setTimeout(() => finish(false), SLACK_IMAGE_VALIDATION_TIMEOUT_MS)
		const cleanup = () => {
			clearTimeout(timeout)
			signal.removeEventListener('abort', onAbort)
			worker.removeAllListeners()
		}
		const finish = (value: boolean) => {
			if (settled) return
			settled = true
			cleanup()
			void worker.terminate().then(
				() => resolve(value),
				() => resolve(false),
			)
		}
		const fail = (error: unknown) => {
			if (settled) return
			settled = true
			cleanup()
			void worker.terminate().then(
				() => reject(error),
				() => reject(error),
			)
		}
		const onAbort = () => fail(signal.reason)
		worker.once('message', (value: unknown) => finish(value === true))
		worker.once('error', fail)
		worker.once('exit', (code) =>
			fail(new Error(`Slack image validation worker exited before returning a result (${code})`)),
		)
		signal.addEventListener('abort', onAbort, { once: true })
		if (signal.aborted) onAbort()
	})
}

export const validateSlackImage = Effect.fn('validateSlackImage')(function* (
	bytes: Uint8Array,
	expectedMime: SlackImageMime,
	signal: AbortSignal,
) {
	const dimensions = yield* Effect.sync(() => {
		try {
			return Option.some(imageSize(bytes))
		} catch {
			return Option.none<ReturnType<typeof imageSize>>()
		}
	})
	if (Option.isNone(dimensions)) return false
	const width = dimensions.value.width
	const height = dimensions.value.height
	const expectedType = expectedMime === 'image/jpeg' ? 'jpg' : expectedMime.slice('image/'.length)
	if (
		dimensions.value.type !== expectedType ||
		width <= 0 ||
		height <= 0 ||
		width > MAX_SLACK_IMAGE_DIMENSION ||
		height > MAX_SLACK_IMAGE_DIMENSION ||
		width * height > MAX_SLACK_IMAGE_PIXELS
	)
		return false
	return yield* validationSemaphore().withPermits(1)(
		Effect.uninterruptible(
			Effect.tryPromise({
				try: () => runImageWorker(bytes, signal),
				catch: () => false,
			}).pipe(Effect.orElseSucceed(() => false)),
		),
	)
})
