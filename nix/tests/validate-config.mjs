import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Config } from '@opencode/schema/config'
import { Schema } from 'effect'

const files = process.argv.slice(2)
assert(files.length > 0, 'Pass at least one generated OpenCode configuration')

for (const file of files) {
	const input = JSON.parse(await readFile(file, 'utf8'))
	Schema.decodeUnknownSync(Config.Info)(input, { onExcessProperty: 'error' })
	console.log(`Validated ${file} against the pinned OpenCode schema`)
}
