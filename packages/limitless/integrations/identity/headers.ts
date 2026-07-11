export function applyCodexIdentityHeaders(
	providerID: string,
	headers: Record<string, string>,
): void {
	if (providerID !== 'openai') return

	// Temporary workaround for anomalyco/opencode#36140: ChatGPT OAuth rejects GPT-5.6
	// Luna requests from OpenCode but accepts the Codex client identity. Remove this once
	// the packaged OpenCode release includes upstream Responses Lite support from #36143.
	headers.originator = 'codex_cli_rs'
	headers['User-Agent'] = 'codex_cli_rs/0.0.0 (OpenCode)'
}
