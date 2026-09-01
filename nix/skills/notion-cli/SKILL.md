---
name: notion-cli
description: Always load this skill when using Notion or the ntn CLI to search, read, create, edit, trash, comment on, query, upload content, or manage Notion Workers
---

# Notion CLI

Use the globally installed official `ntn` CLI for Notion. Prefer its structured
commands and Markdown page operations over constructing raw API requests.

## Discover Commands

- `ntn <command> --help` - verify syntax before an unfamiliar operation.
- `ntn api ls` - list public API endpoints.
- `ntn api <path> --help` - inspect methods and usage for an endpoint.
- `ntn api <path> --docs` - print the endpoint's official documentation.
- `ntn api <path> --spec` - print its reduced OpenAPI schema.
- `ntn doctor` - inspect authentication and CLI health. Authentication is
  automatic when Limitless is configured with a token file; do not log in or
  out unless the user asks.

## Common Reads

- `ntn pages get PAGE_ID --json` - retrieve page properties and Markdown.
- `ntn datasources resolve DATABASE_ID --json` - list a database's data sources.
- `ntn datasources query ID_OR_URL --limit 50 --json` - run a bounded query.
- `ntn api v1/search -d '{"query":"roadmap","page_size":10}'` - search
  accessible workspace content.
- `ntn files list --json` - list the first page of file uploads.

Prefer `--json` for agent-readable output. Keep searches and data-source queries
bounded, and paginate explicitly when complete results are required.

## Common Writes

- `ntn pages create --parent page:PARENT_ID --content '# Title\n\nBody' --json`
- `ntn pages create --parent data-source:DATA_SOURCE_ID < page.md`
- `ntn pages edit PAGE_ID --content '# Updated body' --json`
- `ntn api v1/comments -d '{"parent":{"page_id":"PAGE_ID"},"markdown":"Comment"}'`
- `ntn files create < image.png`
- `ntn pages trash PAGE_ID --yes`

Read a page immediately before editing or trashing it. `ntn pages edit` replaces
the page body, so preserve existing content unless replacement was explicitly
requested. Prefer exact page and data-source IDs for writes. Do not perform
bulk writes or trash multiple pages unless the user explicitly requests the
operation and the selected item count has been verified first.

Use stdin or a file for large Markdown or JSON bodies rather than embedding
them in shell arguments. Use `ntn api` only when a structured command does not
cover the operation, and inspect the endpoint help or schema before writing.

## Workers

- `ntn workers list --json` - list deployed Workers.
- `ntn workers get WORKER_ID --json` - inspect one Worker.
- `ntn workers runs list --worker-id WORKER_ID --json` - list recent runs.
- `ntn workers runs logs RUN_ID` - inspect a run.

Treat deploys, deletes, sync triggers, environment changes, and database
attachments as writes. Inspect the Worker and local configuration first, and
run them only when the user explicitly requests the operation. Database attach
can take over columns and rows and later syncs can delete rows; verify the exact
target and obtain confirmation before attaching.
