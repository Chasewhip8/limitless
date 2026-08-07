---
name: sentry-cli
description: Always load this skill when using Sentry or the sentry CLI to investigate issues, events, traces, logs, replays, releases, alerts, projects, source maps, or API operations
---

# Sentry CLI

Use the globally installed `sentry` command for Sentry investigation and
operations.

## Authentication and Targeting

- Do not run `sentry auth login`, `sentry auth logout`, or `sentry auth token`
  unless the user explicitly asks. Report authentication failures instead of
  changing managed credentials.
- Do not run `sentry cli setup`, `sentry cli upgrade`, or `sentry cli uninstall`.
  Home Manager owns the installation.
- No global organization or project. The CLI may resolve targets
  from explicit arguments, environment variables, `.sentryclirc`, persistent
  defaults, or DSN detection. Verify the resolved organization and project
  before every mutation.

## Discover Commands

- `sentry --help` - list command groups.
- `sentry <group> --help` - list operations for a group.
- `sentry <group> <operation> --help` - verify flags, positionals, and available
  JSON fields before using an unfamiliar command.
- Prefer dedicated commands over `sentry api`. Use `sentry schema <resource>` to
  discover an API endpoint when a dedicated command is unavailable.

## Agent-Readable Output

- Prefer `--json` for machine-readable output.
- Add `--fields <field,...>` when supported to keep results focused. Inspect the
  command's help before selecting fields.
- Bound list operations with `--limit`; paginate further only when needed.
- Use explicit issue short IDs, event IDs, trace IDs, organization slugs, and
  project slugs instead of reselecting targets from broad searches.

## Common Investigation

- `sentry issue list --query "is:unresolved" --limit 20 --json`
- `sentry issue view PROJECT-123 --json`
- `sentry issue events PROJECT-123 --json`
- `sentry event view <event-id> --json`
- `sentry trace list --limit 10 --json`
- `sentry trace view <trace-id> --json`
- `sentry trace logs <trace-id> --json`
- `sentry log list --limit 50 --json`
- `sentry replay list --limit 10 --json`

## Operations

Use command help before operational work. Relevant groups include:

- `sentry issue` - resolve, reopen, archive, or merge issues.
- `sentry release` - create, finalize, deploy, set commits, archive, or delete
  releases.
- `sentry sourcemap`, `sentry debug-files`, `sentry proguard`, and
  `sentry dart-symbol-map` - prepare or upload build artifacts.
- `sentry alert`, `sentry dashboard`, and `sentry project` - manage Sentry
  configuration.
- `sentry monitor run` and `sentry local run` - launch a user command under a
  monitor or local Spotlight server.
- `sentry api <endpoint>` - call an endpoint only when no dedicated command
  covers the requested operation.

## Write Safety

- Run mutations only when the user explicitly requests them.
- Read the exact target first and verify its organization, project, identity,
  current state, and expected impact before changing it.
- Confirm immediately before destructive or bulk operations, including project
  or release deletion, issue merges, trial starts, and multi-target uploads.
- Treat `sentry api` requests using POST, PUT, PATCH, or DELETE as writes.
- Do not bypass confirmation with `--yes`, `--force`, or equivalent flags unless
  the user explicitly approved the verified operation.
