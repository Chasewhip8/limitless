import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, renameSync, writeFileSync, writeSync } from 'node:fs'

// Usage: node t3-desktop-asar.mjs <app.asar> <opener-directory>
const [archivePath, openerDirectory] = process.argv.slice(2)
assert(archivePath && openerDirectory?.startsWith('/'), 'Pass <app.asar> <opener-directory>')

const mainPath = ['apps', 'desktop', 'dist-electron', 'main.cjs']
// T3 hydrates PATH from a login shell or its cache and puts those entries first.
// Every hydrated environment reaches process.env through this publish operation.
const publishStart = `fn("desktop.shellEnvironment.publish")(function* (patch, discovered = false) {
		applyShellEnvironment(env, patch, environment.platform);`
const opener = JSON.stringify(openerDirectory)
const keepOpenerFirst = `fn("desktop.shellEnvironment.publish")(function* (patch, discovered = false) {
		// Limitless: keep the private host opener ahead of hydrated PATH entries.
		if (typeof patch.PATH === "string") patch = { ...patch, PATH: [${opener}, ...patch.PATH.split(":").filter((entry) => entry !== ${opener})].join(":") };
		applyShellEnvironment(env, patch, environment.platform);`

function readAt(descriptor, position, length) {
	const buffer = Buffer.alloc(length)
	assert.equal(readSync(descriptor, buffer, 0, length, position), length, 'Truncated archive')
	return buffer
}

function sha256(buffer) {
	return createHash('sha256').update(buffer).digest('hex')
}

function integrity(content, blockSize) {
	const blocks = []
	for (let start = 0; start < content.length; start += blockSize) {
		blocks.push(sha256(content.subarray(start, start + blockSize)))
	}
	return { algorithm: 'SHA256', hash: sha256(content), blockSize, blocks }
}

function stringPickle(value) {
	const text = Buffer.from(value)
	const padded = Math.ceil(text.length / 4) * 4
	const pickle = Buffer.alloc(8 + padded)
	pickle.writeUInt32LE(4 + padded, 0)
	pickle.writeUInt32LE(text.length, 4)
	text.copy(pickle, 8)
	return pickle
}

const descriptor = openSync(archivePath, 'r')
const headerSize = readAt(descriptor, 0, 8).readUInt32LE(4)
const headerPickle = readAt(descriptor, 8, headerSize)
const header = JSON.parse(
	headerPickle.subarray(8, 8 + headerPickle.readUInt32LE(4)).toString('utf8'),
)
const dataStart = 8 + headerSize
const entry = mainPath.reduce((directory, name) => directory.files[name], header)
assert(entry && !entry.unpacked, `${mainPath.join('/')} must be packed in the archive`)
const original = readAt(descriptor, dataStart + Number(entry.offset), entry.size).toString('utf8')
assert.equal(
	original.split(publishStart).length,
	2,
	'T3 shell environment publication changed; recheck the private opener patch',
)
const patched = Buffer.from(original.replace(publishStart, () => keepOpenerFirst))

// Append the replacement so every other file keeps its offset; the old bytes become unused.
let dataEnd = dataStart
for (const pending = [header]; pending.length > 0; ) {
	for (const node of Object.values(pending.pop().files ?? {})) {
		if (node.files) pending.push(node)
		else if (node.offset !== undefined) {
			dataEnd = Math.max(dataEnd, dataStart + Number(node.offset) + node.size)
		}
	}
}
entry.offset = String(dataEnd - dataStart)
entry.size = patched.length
entry.integrity = integrity(patched, entry.integrity?.blockSize ?? 4 * 1024 * 1024)

const nextHeader = stringPickle(JSON.stringify(header))
const sizePickle = Buffer.alloc(8)
sizePickle.writeUInt32LE(4, 0)
sizePickle.writeUInt32LE(nextHeader.length, 4)

const temporary = `${archivePath}.tmp`
writeFileSync(temporary, Buffer.concat([sizePickle, nextHeader]))
const output = openSync(temporary, 'a')
const chunk = Buffer.alloc(16 * 1024 * 1024)
for (let position = dataStart; position < dataEnd; ) {
	const length = readSync(
		descriptor,
		chunk,
		0,
		Math.min(chunk.length, dataEnd - position),
		position,
	)
	assert(length > 0, 'Truncated archive')
	writeSync(output, chunk, 0, length)
	position += length
}
writeSync(output, patched)
closeSync(output)
closeSync(descriptor)
renameSync(temporary, archivePath)
