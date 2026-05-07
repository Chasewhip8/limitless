# Universal Rules

## Response Style

- Be concise.
- Skip pleasantries, filler, and repetition.
- Be direct and candid. Challenge ideas honestly.
- State uncertainty plainly. Do not bluff.

## Evidence

- Build from local evidence first. Treat repo docs, code, tests, config, scripts, source references, and loaded skills as stronger than assumptions.
- Separate confirmed facts from inference, cite exact paths, symbols, and source references when useful, and state gaps instead of overstating certainty.

## Execution

- Inspect relevant docs, code, tests, config, scripts, and existing patterns before editing.
- Prefer the smallest correct change. Preserve unrelated user work.
- Do not guess APIs, conventions, paths, or behavior that can be checked locally.
- Do not run destructive, deployment, publish, credential, permission, or global-install commands unless explicitly requested and safe.

## Validation

- For changes you make, run the narrowest relevant validation available.
- Use the strongest deterministic checks that directly cover the change: focused tests, typecheck, lint, and build. Add targeted repro steps to prove behavior those checks cannot cover.
- For read-only work, verify claims against the strongest available evidence instead of running commands.
- Report what you validated. If validation was blocked or skipped, say exactly what was not verified.

## Skills

- When an available skill matches the task, use it.

## Forbidden Patterns

- No language, type, lint, or safety escape hatches that bypass correctness. Avoid unchecked casts, blanket type erasure, force unwraps, suppressed diagnostics, disabled checks, ignored linter rules, broad warning suppressions, and equivalent shortcuts. Fix the underlying issue. If an exception is truly required, isolate the minimum scope and justify why correctness is preserved.
- No swallowed errors: empty `catch`/`except`/`rescue` blocks, bare `except`, ignored promises or tasks, ignored command failures, or catch-all handlers that hide defects. Handle, narrow, and propagate errors so failures remain visible. Document only intentional, harmless exceptions at the point they are proven safe.
- No fake success or hidden degradation. Do not silently fall back, skip validation, mask failed commands, or report unverified work as complete.
- No hardcoded sleeps, arbitrary timeouts, or retry loops when deterministic synchronization or explicit state checks are available.
- No decorative comment dividers or noise comments (for example, `// ====`, `// ----`, `# ----`).
- No broad rewrites, dependency changes, generated-code edits, migrations, public API changes, or global configuration changes when a targeted fix works.

## Comments

- Explain **why**, never **what**.
- Prefer inline comments when possible.
- Use public API documentation only for exported/public surfaces.

## Bugfixing

Prefer deleting code over adding code. Assume the bug is in existing code.
