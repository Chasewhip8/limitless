import type { PluginInput } from '@opencode-ai/plugin'
import { describe, expect, test } from 'vitest'
import { createLimitless } from '../index'
import { applyCodexIdentityHeaders } from '../integrations/identity/index'

describe('Codex identity integration', () => {
	test('identifies OpenAI requests as Codex CLI requests', () => {
		const headers = {
			originator: 'opencode',
			'User-Agent': 'opencode/1.17.18',
			'X-Existing': 'preserved',
		}

		applyCodexIdentityHeaders('openai', headers)

		expect(headers).toEqual({
			originator: 'codex_cli_rs',
			'User-Agent': 'codex_cli_rs/0.0.0 (OpenCode)',
			'X-Existing': 'preserved',
		})
	})

	test('leaves other providers unchanged', () => {
		const headers = { originator: 'opencode', 'User-Agent': 'opencode/1.17.18' }

		applyCodexIdentityHeaders('anthropic', headers)

		expect(headers).toEqual({ originator: 'opencode', 'User-Agent': 'opencode/1.17.18' })
	})

	test('is composed into the Limitless plugin', async () => {
		const hooks = await createLimitless()(Object.create(null) as PluginInput)

		expect(hooks['chat.headers']).toBeDefined()
	})
})
