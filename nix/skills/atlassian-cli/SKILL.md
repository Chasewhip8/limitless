---
name: atlassian-cli
description: Always load this skill when using Jira Cloud or Atlassian ACLI to search, inspect, create, edit, comment on, assign, link, or transition Jira work items
---

# Atlassian CLI

Use the globally installed `acli` command for Jira Cloud. ACLI calls Jira issues
"work items" and places their commands under `acli jira workitem`.

## Discover Commands

- `acli jira --help` - list Jira command groups.
- `acli jira workitem --help` - list work-item operations.
- `acli jira workitem <operation> --help` - verify flags before running an unfamiliar operation.
- `acli jira auth status` - inspect the active Jira account. Authentication is automatic when Limitless is configured with a token file; do not log in or out unless the user asks.

## Common Reads

- `acli jira workitem view KEY --json` - retrieve one work item.
- `acli jira workitem view KEY --fields '*all' --json` - retrieve all available fields.
- `acli jira workitem search --jql 'project = PROJ ORDER BY updated DESC' --limit 50 --json` - run a bounded JQL search.
- `acli jira project list --paginate --json` - list visible projects.

Prefer `--json` for agent-readable output. Keep searches bounded unless complete
pagination is required.

## Common Writes

- `acli jira workitem create --project PROJ --type Task --summary 'Summary' --json`
- `acli jira workitem edit --key PROJ-123 --summary 'Updated summary' --yes --json`
- `acli jira workitem comment create --key PROJ-123 --body 'Comment' --json`
- `acli jira workitem transition --key PROJ-123 --status 'In Progress' --yes --json`

Read the target work item before changing it. Prefer explicit work-item keys for
writes. Do not select writes with JQL, filters, or multiple keys unless the user
explicitly requests a bulk operation and the selected item count has been
verified first. Do not use `--ignore-errors` unless partial completion is
intentional.

ACLI does not currently expose worklogs, valid-transition discovery, project
issue-type metadata, or account-ID lookup. Do not invent commands for those
operations; explain the limitation or use another approved integration.
