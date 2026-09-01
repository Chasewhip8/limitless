import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Schema } from 'effect'
import { describe, expect, test } from 'vitest'

const root = fileURLToPath(new URL('../../..', import.meta.url))

const PermissionRule = Schema.Struct({
	action: Schema.String,
	resource: Schema.String,
	effect: Schema.Union([Schema.Literal('allow'), Schema.Literal('ask'), Schema.Literal('deny')]),
})
const CheckedConfig = Schema.Struct({
	$schema: Schema.String,
	default_agent: Schema.String,
	experimental: Schema.Struct({ subagent_depth: Schema.Number }),
	permissions: Schema.Array(PermissionRule),
	providers: Schema.Record(Schema.String, Schema.Unknown),
})
const ReasoningVariant = Schema.Struct({
	id: Schema.String,
	settings: Schema.Struct({
		reasoningEffort: Schema.String,
		reasoningSummary: Schema.optional(Schema.String),
		include: Schema.optional(Schema.Array(Schema.String)),
	}),
})
const ReasoningConfig = Schema.Struct({
	providers: Schema.Struct({
		openai: Schema.Struct({
			models: Schema.Record(
				Schema.String,
				Schema.Struct({
					settings: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
					variants: Schema.optional(Schema.Array(ReasoningVariant)),
				}),
			),
		}),
	}),
})
const PackageManifest = Schema.Struct({
	devDependencies: Schema.Struct({ effect: Schema.String }),
})
const PluginManifest = Schema.Struct({
	dependencies: Schema.Struct({
		'@opencode-ai/plugin': Schema.String,
		'@opencode-ai/schema': Schema.String,
		effect: Schema.String,
	}),
})
function readJson<A, I>(filePath: string, schema: Schema.Codec<A, I>) {
	return Effect.promise(() => readFile(filePath, 'utf8')).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
		Effect.flatMap(Schema.decodeUnknownEffect(schema)),
	)
}

describe('decisive OpenCode 2 cutover', () => {
	test('keeps checked configuration native and ordered', async () => {
		const configPath = path.join(root, 'opencode', 'opencode.json')
		const [config, source] = await Promise.all([
			Effect.runPromise(readJson(configPath, CheckedConfig)),
			readFile(configPath, 'utf8'),
		])

		expect(config.$schema).toBe('https://opencode.ai/config.json')
		expect(config.default_agent).toBe('limitless')
		expect(config.experimental.subagent_depth).toBe(2)
		expect(Object.keys(config.providers)).toContain('openai')
		expect(config.permissions.at(-1)).toEqual({
			action: 'edit',
			resource: '.limitless/repos/**',
			effect: 'deny',
		})
		for (const deprecated of ['"provider"', '"permission"', '"agent"', '"plugin"']) {
			expect(source).not.toContain(deprecated)
		}
		expect(source).not.toContain('headerTimeout')
	})

	test('uses native model variants instead of request reasoning overlays', async () => {
		const directory = path.join(root, 'opencode', 'agents')
		const files = (await readdir(directory)).filter((file) => file.endsWith('.md'))
		const sources = new Map(
			await Promise.all(
				files.map(
					async (file) => [file, await readFile(path.join(directory, file), 'utf8')] as const,
				),
			),
		)

		for (const [name, source] of sources) {
			expect(source, name).not.toMatch(/^(?:permission|disable|reasoningEffort|variant):/mu)
			expect(source, name).not.toMatch(/^\s+(?:task|bash):/mu)
			expect(source, name).not.toContain('reasoning_effort:')
		}
		for (const [name, model] of Object.entries({
			'limitless.md': 'openai/gpt-5.6-sol-fast-long#max',
			'gary.md': 'openai/gpt-5.6-sol-fast-long#xhigh',
			'oracle.md': 'anthropic/claude-fable-5#high',
			'research.md': 'openai/gpt-5.6-sol-fast#medium',
			'review.md': 'openai/gpt-5.6-sol-fast#xhigh',
			'worker.md': 'openai/gpt-5.6-sol-fast#xhigh',
		})) {
			expect(sources.get(name), name).toContain(`model: ${model}`)
			expect(sources.get(name), name).not.toMatch(/^request:/mu)
		}
		expect(sources.get('limitless.md')).toContain('color: "#F8BBD0"')
		expect(sources.get('limitless.md')).not.toMatch(/resource: (?:engineer|frontend)/u)
		expect(sources.get('review.md')).not.toContain('disabled: true')
		expect(sources.get('gary.md')).toMatch(/action: question\s+resource: "\*"\s+effect: deny/mu)
		expect([...sources.values()].join('\n')).toContain('permissions:')
	})

	test('defines OpenAI reasoning only as provider-native variant settings', async () => {
		const config = await Effect.runPromise(
			readJson(path.join(root, 'opencode', 'opencode.json'), ReasoningConfig),
		)
		const models = config.providers.openai.models

		expect(models['gpt-5.6-sol-fast']?.variants).toEqual([
			{ id: 'medium', settings: { reasoningEffort: 'medium' } },
			{ id: 'xhigh', settings: { reasoningEffort: 'xhigh' } },
		])
		expect(models['gpt-5.6-sol-fast-long']).toEqual(
			expect.objectContaining({
				settings: { serviceTier: 'priority' },
				variants: ['none', 'low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({
					id,
					settings: {
						reasoningEffort: id,
						reasoningSummary: 'auto',
						include: ['reasoning.encrypted_content'],
					},
				})),
			}),
		)
		expect(JSON.stringify(config)).not.toContain('reasoning_effort')
	})

	test('pins the runtime-facing packages and Effect together', async () => {
		const [
			rootManifest,
			pluginManifest,
			flake,
			flakeLock,
			bunLock,
			opencodePackage,
			anthropicAuthPackage,
		] = await Promise.all([
			Effect.runPromise(readJson(path.join(root, 'package.json'), PackageManifest)),
			Effect.runPromise(
				readJson(path.join(root, 'packages', 'limitless', 'package.json'), PluginManifest),
			),
			readFile(path.join(root, 'flake.nix'), 'utf8'),
			readFile(path.join(root, 'flake.lock'), 'utf8'),
			readFile(path.join(root, 'bun.lock'), 'utf8'),
			readFile(path.join(root, 'nix', 'packages', 'opencode2.nix'), 'utf8'),
			readFile(path.join(root, 'nix', 'packages', 'anthropic-auth.nix'), 'utf8'),
		])

		expect(rootManifest.devDependencies.effect).toBe('4.0.0-rc.111')
		expect(pluginManifest.dependencies).toEqual(
			expect.objectContaining({
				'@opencode-ai/plugin': '0.0.0-beta-18050',
				'@opencode-ai/schema': '0.0.0-beta-18050',
				effect: '4.0.0-rc.111',
			}),
		)
		expect(flake).toContain('import ./nix/packages/opencode2.nix')
		expect(flake).toContain('import ./nix/packages/notion-cli.nix')
		expect(flake).not.toContain('llm-agents')
		expect(flakeLock).not.toContain('llm-agents')
		expect(flake).toContain('/bin/opencode2 --version')
		expect(bunLock).toContain('@opencode-ai/plugin@0.0.0-beta-18050')
		expect(opencodePackage).toContain('version = "0.0.0-beta-18050"')
		expect(opencodePackage).toContain('x86_64-darwin')
		expect(anthropicAuthPackage).toContain('rev = "f043583c24085c60fc7f95059f2d6f36f44f4a8e"')
		expect(anthropicAuthPackage).toContain('owner = "CasualDeveloper"')
		expect(anthropicAuthPackage).toContain('id !== "ex-machina.anthropic-auth"')
	})

	test('generates native plugin, LSP, skills, Linear, and service configuration', async () => {
		const home = await readFile(path.join(root, 'nix', 'modules', 'home.nix'), 'utf8')
		expect(home).toContain('cfg.opencode.permissions')
		expect(home).not.toContain('cfg.opencode.permission;')
		expect(home).toContain('mcp.servers.linear')
		expect(home).toContain('oauth = false;')
		expect(home).toContain('disabled = false;')
		expect(home).toContain('options = limitlessPluginOptions;')
		expect(home).toContain('plugins.anthropicAuth.enable')
		expect(home).toContain('anthropic-auth.js')
		expect(home).toContain('managedPlugins')
		expect(home).toContain('providers.disabled')
		expect(home).toContain('"google-vertex-anthropic"')
		expect(home).toContain('lsp = lib.optionalAttrs enabledLsp lspServers;')
		expect(home).toMatch(/skillsDirectory = "\$\{opencodeDir\}\/skills";/u)
		expect(home).not.toContain('limitless.js".text')
		expect(home).not.toContain('anthropic-auth.js".text')
		expect(home).not.toContain('/bin/opencode2 --server')
		expect(home).toContain('/bin/opencode2 serve --service')
		expect(home).toContain('LIMITLESS_SLACK_SERVICE=1')
		expect(home).toContain('cfg.opencode.disableClaudeCode')
		expect(home).toContain('cfg.tools.acli.tokenFile')
		expect(home).toContain('cfg.tools.notion.tokenFile')
		expect(home).toContain('cfg.tools.sentry.tokenFile')
	})
})
