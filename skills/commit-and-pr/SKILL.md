---
name: Commit and PR
description: Commit changes and deliver them as a pull request that passes CI. Use when the user asks to commit, push, or open or update a PR.
---

# Commit and PR

A request to commit authorizes the intended commits, and a request to push also authorizes pushing them. A request for a PR authorizes its branch, commits, pushes, history rewrites on that branch, and later fixes. Merging needs its own request. Task-specific instructions, such as one commit, a draft PR, or skipping checks, apply to that task only.

## Procedure

1. **Conventions.** Follow the repository's commit, branch, and PR conventions, falling back to the defaults below.
2. **Commit.** Commit only the intended changes, one commit per meaningful part, on the PR's branch when there is one.
3. **Check.** Make sure local checks pass on what you commit.
4. **Publish.** Push the branch, then open or update the PR.
5. **Watch.** Watch CI on the pushed head with a background command such as `gh pr checks --watch`. A PR with no reported checks has not passed.
6. **Fix.** Investigate failed checks and review comments. Fix what is valid and resolve it, reply with evidence to what is not and leave it to the reviewer, then push and return to step 5. Check with the user before a fix that changes the agreed scope.
7. **Hand off.** Once the PR is green, or only needs the user, report in the hand-off format below.

## History and merging

- Rebase, amend, and force-push the PR branch as needed, with `--force-with-lease`. Keep upstream changes when resolving conflicts.
- Merge only when asked, once checks and reviews allow it, using the repository's merge method or the default below.

## Hand-off

```markdown
**PR:** [<title>](<url>)
**Commits:** `<subject>`, one per line when there are several
**Checks:** <local checks run>, passed | skipped: <which and why>
**CI:** passed | failing: <check>, <cause> | no checks reported: <why>
**Reviews:** <n> fixed, <n> disputed and left open | none
**Gaps:** <what remains or needs the user> | none
```

Omit the PR, CI, and Reviews lines for a commit-only or push-only request.

## Defaults

### Commits

```text
<type>(<scope>): <description>
```

- **Type:** the narrowest truthful one of `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, or `chore`.
- **Scope:** the affected area; omit it when the change spans the repository.
- **Description:** one concise, imperative, lowercase line, without a trailing period or authorship attribution.

```text
feat(sumsub): add company verification workflow
fix(vantage): clarify failure diagnostic provenance
refactor(api): simplify transaction and capability runtime ownership
```

### Branches

`<type>/<short-kebab-name>`, using the commit types.

### Merge method

Squash and merge, using the PR title as the commit subject.

### PR title

The commit format, terse and specific, at most 80 characters: `feat(vantage): add durable account provisioning`.

### PR description

```markdown
## Summary

What the change does, in a sentence or two.

## Why

The problem it solves, and any meaningful departure from the agreed design.

## Changes

- Each concrete change, grouped by area.

## Tickets

- [KEY-123](<tracker URL for KEY-123>)

## Related PRs

- <full GitHub PR URL>
```

- Write in brief, factual language, describe the latest revision only, and omit secrets.
- Include **Tickets** and **Related PRs** only when they exist. Link every ticket key, and link PRs by verified full URL, not `owner/repo#N`.
- Add no mandatory risk or test-evidence sections. Include context such as a small diagram, validation, or deploy notes when it helps review.
