# Limitless

A Nix flake and Home Manager module for OpenCode, with an Effect 4 TypeScript plugin, T3 Code and Paseo bridges, agent definitions, and skills. These instructions govern development of this repository. `opencode/AGENTS.md` is a separate, packaged global instruction file for consumers.

## Architecture and ownership

- Prefer cohesive subsystems with small public APIs and private dependency assembly. Keep dependencies acyclic and coordinate subsystems at composition roots.
- Home Manager owns packages, non-secret configuration, and optional service supervision. OpenCode owns its native service discovery, credentials, sessions, and tool execution.
- Hosted plugins share OpenCode's Effect and plugin runtime. Standalone bridges bundle their own dependencies. Use `portableSchema` at the tool schema boundary between runtimes.
- The shared bridge owns authenticated loopback HTTP transport. Client adapters own their documented request rewrites; plugins own session and tool policy. Do not duplicate policy in the proxy.
- Treat Nix options, tool and plugin IDs, environment variables, launcher announcements, runtime paths, and exported overlay names as consumer contracts. Trace callers before changing them.
- Preserve credential redaction, managed-checkout safety, ordered permission rules, cancellation, and resource ownership when refactoring. Changes to upstream integration assumptions need version-correct evidence and the owning compatibility check.

## Code style

Make operations read as a sequence of meaningful steps. Keep each step's mechanics cohesive and use native facilities when they directly express the work.

These preferences are defaults with exceptions, not mechanical bans. A concrete readability or technical reason can favor another form; an explicitly permitted alternative needs no justification merely for being different.

- Infer application results, including Effect error and requirement channels. Use explicit types for intentional public contracts; keep generic type machinery in its owning subsystem.
- Capture stable services at construction; keep deliberate caller-owned context in method requirements.
- Prefer each `Schema.TaggedError` class's `.make(...)` constructor in new or changed operations.
- Use [Effect Solutions](https://www.effect.solutions/) as a style reference, adapted to the installed Effect version.
- Put Nix option meaning in `description` and use the established module and formatting conventions.

### Effect flow

Prefer named `Effect.fn` and generator bodies for reusable operations, respecting deliberate `Effect.fnUntraced` tracing choices. Use `Effect.gen` for inline Effect blocks. Prefer named yielded results and ordinary statements over `Effect.map`/`flatMap` chains for success-path sequencing, including small standalone operations.

A short inline callback that directly composes already-named operations can stay compact. Do not introduce a generator there solely for consistency.

For a simple field projection from a yielded result, prefer destructuring the result and returning the field over accessing a property on a parenthesized `yield*` expression.

Direct yielded values and yielded object spreads are fine in simple object construction, whether returned or passed to a function. Do not introduce temporaries merely to pull those yields out of the object.

When one yielded operation is the direct positional input to another Effect call inside a generator, prefer a named intermediate result: `const row = yield* read(...); return yield* present(row);`. This does not prohibit yielded field values or object spreads inside an object argument, or establish additional rules for service lookups.

### Native facilities

Use `Option.map` and array `filter`/`map` for straightforward data transformations, `Effect.mapError` for straightforward typed-error translation, and `Effect.forEach` for straightforward effectful traversal. Do not unpack a Result solely to map an error.

Do not force a combinator at the cost of unnecessary intermediate structures. A local loop that directly builds a keyed object can be clearer than an entries array followed by conversion. Local accumulation is allowed. Preserve execution order, concurrency, failure behavior, and result order.

### Guards and branches

Prefer early guards for exceptional cases and resolve dependent missing-value checks before continuing. When no required shared work remains, keep a failure's handling and terminal return together. Do not carry missing values through successive ternaries when guard clauses expose the dependency more directly.

Prefer explicit branches over ternaries that select operations. Simple value ternaries and compact `Option.match` selecting operations are allowed.

Bind locals once. Put derivations needing guards or several branches in a helper that returns early, and bind its result with `const`. When a value-producing branch performs a workflow step, extract an operation named for that step and yield it where the branch was. Value ternaries, `??`, compact `Option.match`, and local accumulation remain fine.

### Meaningful helpers

Extract a helper when its name makes the caller read more clearly as meaningful steps. Data preparation and decoding can be useful steps even with one caller.

Keep related mechanics together. Do not extract every field transformation or expression merely to shorten functions. Weigh clarity at the caller against indirection and type/API scaffolding; no fixed line count or reuse count decides extraction.

An inline callback may already name its step through `Effect.fn("Meaningful.operation")`. Preserve that structure and its contextual inference when extraction would mainly shorten the function while requiring a manually restated parameter shape. An unnamed phase can still justify a typed helper.

Preserve the exact resource boundary, service ownership, error channels, and tracing behavior. Extraction must not quietly change those semantics.

### Declaration locality

Declare local values near their first meaningful use and keep related declarations and consumers together. Do not move eager work, snapshots, service capture, or resource acquisition across effects, branches, or loops merely to reduce textual distance. This does not establish a fixed ordering for module-level helpers.

### Effect boundaries and phase grouping

Put the generator directly in `Effect.fn`; use its trailing transformations for behavior applying to the whole operation. Avoid an extra function/generator wrapper used only to obtain a `.pipe` attachment point.

Use local `.pipe` transformations for one inner operation. Keep a nested `Effect.gen` when its scope covers only part of the enclosing operation; never widen a narrower boundary solely to flatten nesting.

Keep lookup/guard/unwrap sequences together. Separate larger logical phases with blank lines, rather than placing a blank line between every statement.

## Comments

- If a reader can determine what something is or does from the code, including its implementation, do not comment it. Let names, types, and steps explain the code.
- On public contracts, document only caller obligations the code cannot show, such as where or when to call, replay or ordering requirements, and conventions consumed elsewhere.
- Put API, schema, CLI, and Nix option meaning in their description/help metadata, not comments.
- Keep external references, upstream compatibility constraints, and security or lifecycle reasons that the implementation alone cannot explain. Tool directives are exempt.

## Reviews

- Apply the defaults and explicit permissions above. Report a concrete readability improvement, not merely a syntactic difference; cite the applicable default and explain what becomes easier to understand.
- Weigh clarity and maintenance benefits against introduced complexity. Group related findings into recommendations; prefer a few persuasive findings to a quota. A clean assessment is valid.
- Check surrounding code before proposing extraction, reordering, or combinator rewrites. Do not suggest a style-only change whose semantics you cannot account for.
- Do not invent further rules about type annotations, naming, helper order, mutation generally, tracing every helper, explicit concurrency everywhere, or numeric complexity limits.
- An audit proposes changes; implementation needs a request.

## Tests and checks

Keep tests deterministic, isolated, and focused on consequential guarantees or compatibility regressions. Name the failure each prevents, check existing coverage, and give each guarantee one primary owner. Do not add tests for code style or removed implementation details.

- `packages/limitless/test/` contains Vitest tests and local fixtures.
- `nix/packages/*.test.mjs` exercises service provisioning and launchers; the flake checks run these with their pinned runtimes.
- `nix/tests/` validates generated configuration, upstream contracts, and isolated real-process integrations. Do not point fixtures at live user state.
- Bootstrap with `nix develop`, then `bun install --frozen-lockfile`. Run `bun run ci` for lint, typechecks, tests, host flake checks, and package builds. Use `bun run format` to format changes.
- Refresh fixed-output hashes when dependency trees or pinned archives change. Rebuild dependency derivations when necessary so cached outputs cannot conceal stale hashes.
- For T3 browser packaging changes, run the documented `t3-browser` smoke runner outside the Nix build sandbox on the target host.

## Safety and delivery

- Do not apply Home Manager/NixOS or restart live `opencode`, `t3code`, or `paseo` services from an agent working inside them. Ask the user to apply reviewed changes; validation uses isolated fixtures.
- Never print credentials, mutable account databases, or private service environment values. Keep secrets outside the Nix store.
- Preserve unrelated changes and concurrent work. A PR request authorizes a task branch, intended commits, push, and PR creation, not deployment.
- Use conventional commits with the narrowest truthful type and a concise, imperative, lowercase description. Add a scope when it clarifies the affected area.

## Starting points

- `flake.nix`, `nix/modules/`, `nix/packages/` — exported packages, consumer options, and pinned builds.
- `packages/limitless/index.ts`, `plugin/`, `tools/` — hosted plugin composition, execution boundary, artifacts, and guarded source research.
- `packages/limitless/bridge/`, `t3/`, `paseo/` — shared transport, client adapters, and runtime policy.
- `packages/limitless/tui.ts`, `cache-status/` — notification handler and prompt-cache indicator.
- `opencode/`, `skills/` — packaged defaults and instructions; changes here affect consumers, not just this repo.
- `README.md` — consumer setup, compatibility boundaries, migration notes, and development checks.
