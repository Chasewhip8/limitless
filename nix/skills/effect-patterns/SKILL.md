---
name: effect-patterns
description: Portable Effect patterns for runtime composition, service lifetime, typed errors, and testable resource ownership.
---

# Effect Patterns

Use this skill before writing or refactoring Effect code.

## Required Workflow

1. Inspect nearby repo code first to find the established Effect style.
2. Run `effect-solutions list` to see available local guides.
3. Run `effect-solutions show <topic>...` for relevant patterns before using unfamiliar APIs.
4. Check real implementations in the host repo when available.
5. Only then write or change Effect code.

Never guess at Effect patterns when the API or lifecycle model is unclear.

## Effect Solutions CLI

Use the installed `effect-solutions` CLI as the first local reference for Effect guidance:

- `effect-solutions list` - list available guides and topics
- `effect-solutions show quick-start` - review basic Effect usage
- `effect-solutions show project-setup tsconfig` - configure project setup and TypeScript options
- `effect-solutions show services-and-layers error-handling testing` - fetch multiple relevant guides at once

## Topics

- `quick-start`
- `project-setup`
- `tsconfig`
- `basics`
- `services-and-layers`
- `data-modeling`
- `error-handling`
- `config`
- `testing`
- `cli`

## When to Use

- Adding new Effect services, layers, schemas, or CLI commands
- Refactoring existing Effect code
- Debugging unfamiliar Effect APIs or patterns
- Writing tests around Effect workflows

## Preserve These Patterns

### 1. Build the app as a small layer graph

Treat config, infra, HTTP, and long-lived workers as composable layers.

- Keep application assembly visible near the entrypoint
- Prefer a few meaningful layers over a sprawling mesh of tiny wrappers
- Make dependency wiring explicit rather than hiding it across unrelated modules

### 2. Keep HTTP contracts separate from live handlers

Separate boundary contracts from the live code that fulfills them.

- Keep payload, success, and failure shapes close to the boundary definition
- Let handlers translate contracts into domain work
- Keep cross-cutting middleware and transport concerns out of individual handlers when possible

### 3. Use `Effect.Service` as the unit of runtime composition

Reach for `Effect.Service` when a module owns dependencies or lifecycle, unless the host repo already has a coherent alternative.

- Use regular service construction for stateless or request-scoped integrations
- Use scoped construction when the module owns connections, listeners, fibers, or cleanup
- Make service lifetime obvious in the module that creates the resource

### 4. Model background workers as scoped fibers

Polling loops should be explicit, bounded, and owned by scope.

- Use `Effect.repeat(Schedule.spaced(...))` for cadence
- Use `Effect.forEach(..., { concurrency })` for bounded fan-out
- Use `Effect.forkScoped` so worker lifetime matches the service scope
- Prefer a small orchestrator service that delegates the real work to narrower modules

### 5. Push failures into tagged domain errors

Prefer `Schema.TaggedError` plus `catchTag` or `catchTags` over unstructured exception handling.

- Decode and validate input at boundaries
- Map SDK, transport, and persistence failures into stable domain errors
- Translate domain errors into transport-specific responses at the edge

### 6. Keep resource ownership explicit at the boundary

Use scoped layers and acquire/release for infrastructure that must be opened and closed safely.

- Prefer `Layer.scoped` and `Effect.acquireRelease` for anything that must be opened and closed safely
- Keep transaction helpers, retry policy, and failure classification close to the infrastructure boundary that owns them
- Do not spread resource lifecycle logic across business modules

### 7. Reuse the runtime in tests

Test with the same layer model used in production.

- Assemble tests from the same service graph or runtime factory used by production where practical
- Replace only the dependencies that need to change for the test
- Reuse typed contracts in test clients when the transport boundary is part of the behavior under test

## Do Not Generalize

- One repo's exact file names, folder names, or entrypoint layout
- Local helper tools or reference directories as if they were mandatory Effect workflow
- Generated artifacts, scripts, snapshots, and SDK quirks as examples of core runtime design
- Escape hatches like `throw new Error`, `Effect.die`, or `Effect.orDie` as if they were the preferred boundary strategy

## Quick Check

- Did I make runtime composition visible and coherent?
- Did I model service lifetime explicitly?
- Did I keep background work owned by scope rather than incidental imports?
- Did I translate failures into stable domain errors at the boundary?
- Did I reuse the production runtime shape in tests where it mattered?
