---
name: service-patterns
description: Portable heuristics for architecting services in any repo by adapting strong boundaries, ownership, and runtime composition patterns without cargo-culting source layouts.
---

# Service Patterns

Use this skill when you want to carry good service architecture patterns from one codebase into another.

The goal is not to copy filenames, folders, or framework rituals. The goal is to extract the underlying pattern, verify it fits the host repo, and apply it in the host repo's own style.

## When to Use

- Adding or refactoring backend or service-layer modules
- Translating patterns from a reference repo into a new codebase
- Auditing whether a codebase's current structure is strong, accidental, or overfit

## First Inspect the Repo

Before changing anything, identify the host repo's actual conventions.

1. Find how the repo organizes capabilities.
   - Look for feature folders, horizontal layers, or package boundaries.
   - Do not assume capability folders are correct unless the repo already trends that way.

2. Find the source of truth for types.
   - Check whether types come from schemas, ORM models, generated clients, protocol definitions, or hand-written interfaces.
   - Prefer deriving from existing authoritative sources over duplicating shapes.

3. Find the dependency model.
   - Check for Effect layers/services, constructors, factory functions, module singletons, or framework-managed DI.
   - Reuse the repo's established abstraction if it is coherent.

4. Find the boundary style.
   - Look at how the repo models HTTP contracts, external SDK wrappers, persistence helpers, and error translation.
   - Distinguish boundary modules from core domain logic.

5. Find the runtime and test seams.
   - Check how the app boots, how long-lived work is started, and how tests assemble runtime dependencies.

## Adapt to the Host Repo

Mirror the host repo unless the existing pattern is clearly weak or inconsistent.

- Match the repo's naming scheme before introducing new suffixes like `service`, `live`, `api`, `adapter`, or `schema`
- Match the repo's folder depth and package boundaries before creating new subtrees
- Match the repo's error style, config style, and test style before importing patterns from elsewhere
- Treat source-repo examples as evidence, not as a template to copy blindly

If the host repo has no clear pattern, prefer simple, explicit structure over clever abstractions.

## Service Architecture Patterns

### 1. Organize around cohesive capabilities

Keep code that changes together close together.

- Group contracts, implementation, and support code by feature or capability when the repo supports that style
- Split only when a boundary is real: public contract, runtime adapter, persistence model, or reusable utility
- Avoid scattering one feature across unrelated folders unless the repo already uses a disciplined layered layout

### 2. Make boundaries explicit

Separate the shape of the outside world from the code that performs domain work.

- Keep transport, persistence, and external integration concerns at the edge
- Keep contracts, adapters, and middleware distinct from core workflows
- Let the service interior speak in domain concepts instead of transport-specific details

### 3. Make ownership visible

A service should show where configuration, infrastructure, long-lived work, and cleanup are owned.

- Keep application assembly close to the entrypoint or composition root
- Make startup and shutdown responsibilities visible instead of scattering them across incidental imports
- Ensure resource and process ownership is obvious in the module that creates them

### 4. Prefer small orchestrators over giant workflow modules

Top-level service modules should coordinate work, not absorb every implementation detail.

- Let orchestrators delegate to narrower modules for persistence, transport, and domain operations
- Keep fan-out, scheduling, and retry policies explicit at orchestration boundaries
- Avoid service modules that mix HTTP, DB, SDK, and business rules in one large file

### 5. Keep support artifacts out of the architecture story

Operational scripts, snapshots, generated files, and one-off maintenance tools are useful, but they should not define the core service design.

- Keep operational utilities in clearly separate locations
- Treat generated artifacts and snapshots as outputs, not source architecture
- Do not infer core design rules from manual repair paths or local tooling

## Boundary Translation Rules

When copying a pattern from another repo, translate it instead of cloning it.

- `*.api.ts` plus `*.live.ts` means: separate contract from implementation
- A composition root means: keep assembly visible in one place
- A dedicated worker module means: give long-lived background work a clear owner
- A typed error boundary means: prevent transport or integration failures from leaking raw into the domain
- Typed test clients mean: reuse public contracts in tests instead of rebuilding request shapes by hand

Ask: "What problem was this pattern solving in the source repo?" Then solve that same problem in the host repo's own idiom.

## Testing and Runtime Parity

Tests should reuse as much of the real runtime shape as practical.

- Prefer assembling tests from the same app factory, runtime setup, or dependency container used by production
- Replace only the dependencies that need to change for the test
- Keep transport contracts shared between production and test clients when possible
- Favor integration seams that prove the runtime wiring actually works

## Do Not Cargo-Cult

- Do not copy source-repo filenames, folder names, or suffixes just because they looked clean elsewhere
- Do not make local tools, paths, or reference directories mandatory unless they exist in the host repo
- Do not treat generated artifacts, scripts, snapshots, or SDK quirks as reusable architecture
- Do not oversell a pattern as universal when it was only solving one repo's local problem

## Quick Check

Before you finalize a change, verify these questions:

- Did I preserve the principle rather than the literal file layout?
- Did I keep boundary translation separate from core domain logic?
- Did I make runtime ownership and cleanup explicit where needed?
- Did I follow the host repo's conventions unless there was a strong reason not to?
