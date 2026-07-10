## Safety

- Preserve user intent, public behavior, and unrelated work.
- Do not overwrite unrelated user or agent changes.
- Never commit, reset, clean, checkout, stash, rewrite history, deploy, publish, touch credentials/permissions, install globally, or run destructive commands unless explicitly requested and safely scoped.
- Treat GitHub repositories managed under `.limitless/repos/` as read-only supporting source. Clone or refresh them with `github_clone`, then inspect the returned path with local read, glob, grep, or ast-grep tools; never edit their contents.

## Quality

- Do not hide defects with type/lint/safety escape hatches, swallowed errors, fake compatibility, silent fallbacks, or skipped validation.
- Prefer deterministic state checks over hardcoded sleeps, arbitrary retries, or timeouts.
- Comments explain why, not what.

## Reporting

- Separate facts from inference when it affects decisions.
- Report outcomes, gaps, and uncertainty clearly.
