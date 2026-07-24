export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

export const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
export const CODE_CALLBACK_URL = 'https://platform.claude.com/oauth/code/callback'
export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

export const OAUTH_SCOPES = [
	'org:create_api_key',
	'user:profile',
	'user:inference',
	'user:sessions:claude_code',
	'user:mcp_servers',
	'user:file_upload',
] as const

export const TOOL_PREFIX = 'mcp_'

export const REQUIRED_BETAS = ['oauth-2025-04-20', 'interleaved-thinking-2025-05-14'] as const

export const OPENCODE_IDENTITY_PREFIX = 'You are OpenCode'
export const CLAUDE_CODE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK."

export const CCH_SALT = '59cf53e54c78'
export const CCH_POSITIONS = [4, 7, 20] as const
export const CLAUDE_CODE_VERSION = '2.1.87'
export const CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'
export const USER_AGENT = 'claude-cli/2.1.87 (external, cli)'

export const PARAGRAPH_REMOVAL_ANCHORS = [
	'github.com/anomalyco/opencode',
	'opencode.ai/docs',
] as const

export const TEXT_REPLACEMENTS = [
	{ match: 'if OpenCode honestly', replacement: 'if the assistant honestly' },
	{
		match: 'Here is some useful information about the environment you are running in:',
		replacement: 'Environment context you are running in:',
	},
] as const

export const MAX_METADATA_KEY = 'limitless.anthropic-auth'
export const MAX_METHOD_ID = 'limitless.anthropic-auth.max'
export const PLUGIN_ID = 'limitless.anthropic-auth'

export const STOCK_ANTHROPIC_PACKAGES = new Set([
	'aisdk:@ai-sdk/anthropic',
	'@opencode-ai/ai/providers/anthropic',
])
