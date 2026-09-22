## Safety

- Preserve user intent, public behavior, and unrelated work.
- Do not overwrite unrelated user or agent changes.
- Never commit, reset, clean, checkout, stash, rewrite history, deploy, publish, touch credentials/permissions, install globally, or run destructive commands unless explicitly requested and safely scoped.
- Treat GitHub repositories managed under `.limitless/repos/` as read-only supporting source. Clone or refresh them with `github_clone`, then inspect the returned path with local read, glob, grep, or ast-grep tools; never edit their contents.

## Quality

- Do not hide defects with type/lint/safety escape hatches, swallowed errors, fake compatibility, silent fallbacks, or skipped validation.
- Prefer deterministic state checks over hardcoded sleeps, arbitrary retries, or timeouts.
- Comments explain why, not what.

## Service integrations

- Use configured MCP tools for connected services. Discover the exact tool and account before calling it.
- Confirm the intended account, workspace, and target before changing external data. Ask when account selection is ambiguous.
- If a connection needs authentication, ask the user to sign in through `/mcps`. Never read OAuth state or token files to work around a denied tool or missing connection.

## Reporting

- Separate facts from inference when it affects decisions.
- Report outcomes, gaps, and uncertainty clearly.
