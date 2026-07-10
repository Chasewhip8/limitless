---
name: review-general
description: Use ONLY when the caller explicitly names review-general for a deterministic baseline review of repository-defined style, compilation, typechecking, tests, and diff hygiene
---

# General Review

Perform a deterministic baseline review. Repository instructions and executable checks are authoritative; personal taste is not.

## Scope

Review only the target supplied by the caller. Preserve unrelated work. If the target or its applicable validation boundary is unclear, report the missing scope instead of broadening it.

## Rules

### GEN-01 — Repository instructions (MUST)

- Discover and follow every applicable `AGENTS.md`, checked-in contributor guide, formatter/linter configuration, and CI contract for the target.
- Treat machine-enforced repository rules as authoritative. Do not invent style rules that the repository does not encode.
- Fix deterministic violations in scope. Report conflicting instructions rather than choosing silently.

### GEN-02 — Formatting and lint (MUST)

- Identify formatter and lint commands from checked-in scripts, manifests, or CI.
- Run the narrowest authoritative checks that cover the target, followed by the repository's broader required check when practical.
- Fix in-scope formatter and lint failures. Do not suppress rules, add ignore directives, or weaken configuration merely to pass.

### GEN-03 — Compilation and type safety (MUST)

- Run the repository's declared compile, build, or typecheck command that covers the target.
- Fix in-scope failures caused by the reviewed implementation.
- Do not hide failures with unsafe casts, blanket suppressions, skipped validation, fake compatibility layers, or swallowed errors.
- If the repository declares no applicable compile or typecheck command, report that gap; do not invent one.

### GEN-04 — Tests (MUST)

- Run focused tests for changed behavior when they exist, then the relevant repository test command when practical.
- Fix deterministic in-scope failures. Distinguish pre-existing or unrelated failures with concrete evidence.
- Do not delete, skip, weaken, or rewrite valid tests solely to make the implementation pass.

### GEN-05 — Diff hygiene (MUST)

- Remove unresolved conflict markers, accidental debug output, abandoned commented-out code, and unrelated generated or temporary files introduced by the target.
- Require comments to explain why rather than restate what the code does.
- Do not demand unrelated cleanup or subjective refactoring.

## Evidence

For every issue, cite the rule and concrete path, command output, or diff evidence. If every applicable rule passes, return no findings rather than speculative feedback.
