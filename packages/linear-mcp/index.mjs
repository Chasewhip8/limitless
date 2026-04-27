/**
 * OpenCode plugin that adds the Linear MCP server via the config hook.
 * Requires LINEAR_API_KEY environment variable.
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export default async () => ({
	config: (cfg) => {
		const apiKey = process.env.LINEAR_API_KEY
		if (!apiKey) return

		cfg.mcp ??= {}
		cfg.mcp.linear = {
			type: 'remote',
			url: 'https://mcp.linear.app/mcp',
			enabled: true,
			headers: { Authorization: `Bearer ${apiKey}` },
			oauth: false,
		}
	},
})
