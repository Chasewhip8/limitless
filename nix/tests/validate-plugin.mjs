import assert from 'node:assert/strict'
import { Host } from '@opencode/plugin/host'

const [directory] = process.argv.slice(2)
assert(directory, 'Pass the built Limitless package directory')

// OpenCode bundles Bun 1.4.2; build-host Bun 1.3.13 throws non-Error resolution
// failures for optional entrypoints. Use OpenCode's supported Node loader here.
const entrypoints = Host.resolve({ directory })
assert(entrypoints.server, 'Missing Limitless server entrypoint')
assert(entrypoints.tui, 'Missing Limitless TUI entrypoint')

const server = await Host.load(entrypoints.server)
assert.equal(server.default.id, 'limitless')
assert.equal(typeof server.default.effect, 'function')

const tui = await Host.load(entrypoints.tui)
assert.equal(tui.default.id, 'opencode.notifications')
assert.equal(typeof tui.default.setup, 'function')
console.log(`Validated server and TUI entrypoints in ${directory}`)
