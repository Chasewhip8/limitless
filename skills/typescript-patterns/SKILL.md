---
name: typescript-patterns
description: Portable TypeScript structure and typing patterns for service code, focused on source-of-truth types, module boundaries, and maintainable domain modeling.
---

# TypeScript Patterns

Use this skill when adding or refactoring TypeScript structure in service code.

## When to Use

- Adding new modules, folders, or file boundaries
- Defining domain types that should stay aligned with runtime sources of truth
- Refactoring service code to make type relationships clearer
- Deciding what belongs in shared schema, error, utils, or script modules

## Patterns to Preserve

### 1. Organize by capability, not by file type

Keep each capability in its own folder with a small set of role-based files.

- Keep code that changes together close together
- Split modules by real boundaries such as public contracts, runtime adapters, persistence models, or reusable helpers
- Avoid scattering one feature across unrelated folders unless the host repo already uses a disciplined layered layout

### 2. Derive types from the real source of truth

Avoid hand-maintained duplicate interfaces when the type already exists elsewhere.

- Derive from schemas, ORM models, generated clients, protocol definitions, or library APIs where possible
- Use `Parameters<>`, `ReturnType<>`, indexed access types, and `typeof` to stay aligned with the authoritative source
- Introduce hand-written interfaces only when no stable source exists or when a narrower domain type improves clarity

### 3. Use narrow domain types before branching

Model the smallest useful subtype before the main workflow runs.

- Turn broad input into discriminated or narrowed domain cases at the boundary
- Keep branching logic explicit when behavior genuinely differs by kind, provider, transport, or mode
- Prefer a few well-named narrowed types over repeated inline conditionals and casts

### 4. Keep boundary helpers in small leaf modules

Put serialization, codec, error, and utility details in focused support files instead of mixing them into large services.

- Keep codecs, parsers, serializers, transport wrappers, and date or time helpers in focused modules
- Let boundary helpers absorb external weirdness so service workflows stay legible
- Do not let tiny helpers quietly grow into hidden service layers

### 5. Keep operational scripts outside the runtime graph

One-off scripts should stay in `scripts/` and not shape the main application architecture.

- Keep operational scripts and repair utilities in dedicated script or tool locations
- Do not treat hard-coded inputs, migration snapshots, or one-off maintenance code as architectural patterns

### 6. Prefer explicit type-safe boundaries over escape hatches

When a type feels awkward, fix the model or boundary before reaching for assertions.

- Narrow unknown input through decoding, parsing, or validation before it enters domain workflows
- Keep assertions local to integration edges when a third-party API leaves no better choice
- Avoid spreading broad assertions through business logic just to satisfy the compiler

## Do Not Generalize

- A specific repo's folder names, suffixes, or file pair conventions
- ORM-specific or schema-library-specific APIs as if they were universal TypeScript rules
- Generated artifacts, snapshots, and manual scripts as examples of core architecture
- Local casts and SDK workarounds as if they were normal domain modeling practice

## Quick Check

- Did I derive types from the strongest available source of truth?
- Did I narrow domain cases before branching on behavior?
- Did I keep boundary helpers separate from core workflows?
- Did I avoid copying another repo's folder layout without checking the host repo first?
