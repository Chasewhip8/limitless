---
name: document-architecture
description: Generate or update docs/ARCHITECTURE.md to reflect the current codebase structure, components, and relationships. Use when onboarding, after major refactors, or for periodic documentation refresh.
user-invocable: true
disable-model-invocation: true
argument-hint: [output-path]
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash
---

# Document Architecture Skill

Analyze a codebase and generate or update `docs/ARCHITECTURE.md` to accurately reflect the current system structure, component relationships, and key abstractions.

## When to Use

- **Onboarding**: When new developers need to understand system structure
- **After major refactors**: When architecture has changed but documentation hasn't
- **Periodic maintenance**: Quarterly architecture doc refresh
- **Before architectural decisions**: To establish a baseline understanding
- **Code review context**: When reviewing changes that affect multiple components

## Key Principle: Reality Over Aspiration

Document **what the codebase actually is**, not what it should be. If the architecture is messy, reflect that honestly.

## Output Path

- Default: `docs/ARCHITECTURE.md`
- If `docs/` doesn't exist: `ARCHITECTURE.md` in project root
- If `$0` argument provided: use the provided path

## Required Workflow

1. Locate existing architecture documentation and preserve manual sections marked with `<!-- manual-start -->` / `<!-- manual-end -->`.
2. Detect project type from package/build files.
3. Map top-level directories, source directories, and entry points.
4. Identify architectural components, data flow, and key abstractions from actual files.
5. Generate documentation from observed reality, not desired architecture.
6. Verify referenced paths exist before reporting completion.

## Required Sections

1. Header with metadata and auto-generated notice
2. System overview
3. Components with locations, responsibilities, and dependencies
4. Data flow
5. Key abstractions
6. Directory structure
7. External dependencies
8. Cross-cutting concerns

## Performance Notes

For large codebases, limit dependency tracing depth, sample representative files, skip vendored/generated directories, and keep diagrams focused on the core system.
