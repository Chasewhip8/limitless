import { parentPort, workerData } from 'node:worker_threads'

if (
	typeof workerData !== 'object' ||
	workerData === null ||
	typeof workerData.wasmPath !== 'string' ||
	!(workerData.bytes instanceof ArrayBuffer)
)
	throw new Error('Invalid Slack image validation worker input')

;(
	globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }
).__OPENCODE_PHOTON_WASM_PATH = workerData.wasmPath

import('@silvia-odwyer/photon-node').then(
	(photon) => {
		let image: InstanceType<typeof photon.PhotonImage> | undefined
		try {
			image = photon.PhotonImage.new_from_byteslice(new Uint8Array(workerData.bytes))
			parentPort?.postMessage(image.get_width() > 0 && image.get_height() > 0)
		} catch {
			parentPort?.postMessage(false)
		} finally {
			image?.free()
			parentPort?.close()
		}
	},
	() => {
		parentPort?.postMessage(false)
		parentPort?.close()
	},
)
