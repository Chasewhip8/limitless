# Code patterns

The conventions for code in this repository, with the file that shows each one. The boundaries these
patterns protect are in [ARCHITECTURE.md](ARCHITECTURE.md); the reasons for the larger choices are
in the [decision records](adr/2026.md).

## Services and layers

Prefer cohesive subsystems with small public APIs and private dependency assembly. Keep dependencies
acyclic and flowing down the hierarchy. Coordinate subsystems through public APIs in higher-level
use cases; keep application wiring at composition roots.

A subsystem exposes one service class built from a `make` effect, and one layer:

```ts
// apps/api/src/grant/service.ts
const make = Effect.gen(function* () {
  const provideDatabase = yield* Database.provider;
  const customers = yield* CustomerService;
  // ...operations defined with Effect.fn("GrantService.<name>")
  return { activeGrants, restrictions, restrict, lift };
});

export class GrantService extends Context.Service<GrantService, Effect.Success<typeof make>>()(
  "api/grant/GrantService",
) {}

export const grantServiceLayer = Layer.effect(GrantService, make);
```

- The service type is inferred from `make`; write an explicit interface only for a contract other
  code implements or consumes generically (`Grants`, `Issues`, a provider `Projection`).
- Service identifiers are `"<app or package>/<subsystem>/<Name>"`, for example
  `"api/workflow/WorkflowRegistry"` or `"common/gcs/Gcs"`.
- Capture stable services (`Database.provider`, other services, `SecureRandom`, `Digest`) once in `make`; each
  operation applies `provideDatabase` as a trailing transformation instead of requiring `Database`
  from its caller. Keep deliberate caller-owned context in method requirements.
- A feature directory keeps the same split: `api.ts` (endpoints), `handlers.ts` (binds endpoints to
  the service, nothing else), `service.ts`, `persistence.ts`, `schema/`. Persistence modules are
  private to their feature; `.oxlintrc.json` rejects imports of another feature's `persistence*`
  file.
- The API's layers are assembled in `apps/api/src/server.ts`, and the workflow catalog with its
  provider accounts in `apps/api/src/workflow/catalog.ts`; the workflow lists are in
  `apps/api/src/workflow/definitions/index.ts`.

## Database access and transactions

Application code owns business rules and workflow order. The database owns relational integrity and
concurrency: keys, constraints, uniqueness, transactions, and locks. Give each rule one owner. Don't
store flags that only record that validation ran; add database enforcement only for a concrete
storage or concurrency need.

Outside `apps/api/src/database/`, reach SQL only through `Database`. Lint forbids importing
`effect/sql`'s `SqlClient`, `@effect/sql-pg` and `drizzle-orm/effect-postgres` elsewhere.

- Every statement is `Database.query("<subsystem>.<operation>", (db) => ...)`. The name appears in
  traces and in database defects, so make it specific.
- The operation that owns the unit of work declares the transaction as the trailing transformation
  of its `Effect.fn`:

  ```ts
  // apps/api/src/workflow/activation.ts
  export const activateWorkflow = Effect.fn("Workflow.activate")(function* (workflow) {
    // lock, compare, update, cancel superseded runs
  }, Database.transaction("workflow.activate"));
  ```

- Exactly one owner: a nested `Database.transaction` dies with `transaction_active` before its body
  runs. Helpers that need the caller's transaction call `Database.inTransaction` (or
  `Database.requireSnapshot` when they need repeatable read); code that waits or calls the network
  calls `Database.requireNoTransaction` first.
- The transaction body may run again after a deadlock or serialization failure. Keep it sequential
  and free of side effects outside the database; send notifications and start outside work after it
  commits.
- Check state and write it in the same transaction instead of mirroring the workflow in SQL
  triggers, and lock what the check depends on (`lockCustomer`, `lockWorkflowActivation`); don't
  rely on unlocked read-then-write checks. Pick the isolation level per transaction;
  `Database.transaction` defaults to read committed.
- Customer, relationship and document data are append-only revisions. Add a revision; never update
  or delete one.

## Workflow definitions

A workflow is a value made with `defineWorkflow` and listed in
`apps/api/src/workflow/definitions/index.ts`:

```ts
// apps/api/src/workflow/definitions/development-sft-customer.ts
export const developmentSftCustomer = defineWorkflow({
  id: WorkflowId.make("development-sft-customer"),
  revision: WorkflowRevision.make(1),
  evaluate: Effect.gen(function* () {
    const { subject } = yield* Data;
    yield* requireSftProfile(subject);
  }),
  complete: Effect.gen(function* () {
    const { subject } = yield* Data;
    yield* ensureSftCustomer(subject);
    yield* (yield* Grants).grant("development-vantage-usd");
  }),
});
```

- `evaluate` reads only captured data (`Data`, `Documents`) and records findings through `Issues`.
  It cannot use `Reviews`, `Grants`, `Run` or any provider service; `defineWorkflow` turns that into
  a type error. Every finding must be something the applicant can fix.
- `complete` runs only when `evaluate` recorded no findings. It does provider work and opens
  reviews; it calls `Grants.grant` only after the checks and provider work the grant key stands for
  have succeeded.
- Shared checks live in `apps/api/src/workflow/checks/`. A provider's account declaration and the
  workflow steps that call it live in `workflow/definitions/<provider>.ts` (for example
  `ensureSftCustomer` in `sft.ts`).
- Do not change `revision` while the project is greenfield; see
  [Greenfield schemas](../CONTRIBUTING.md#greenfield-schemas).

## Provider extensions and simulators

Each provider has a directory under `apps/api/src/` with an `index.ts` that declares accounts:

- `make(id)` returns a `Context.Service` whose instance type extends `CompletionOnly`, which is what
  keeps it out of `evaluate`, and a `.layer(config)` that builds it from validated settings
  (`apps/api/src/sft/index.ts`).
- Provider code uses workflow internals only through `apps/api/src/workflow/extension/index.ts`;
  lint enforces this for `sumsub/` and any `*/extension/` directory.
- Build provider methods with `Extension.make(name)` and `extension.method(...)`. A method body may
  run again on replay, so put every provider call inside an `Activity` and make the body find the
  operation its first call started instead of starting another.
- Journal anything replay must not reread from current settings: the target and retry limits
  (`apps/api/src/arcadia/extension.ts`, `apps/api/src/sft/extension.ts`).
- Retry with `pause` from `apps/api/src/durable/durable.ts` (durable exponential backoff), not
  `Effect.retry`, so a wait survives a restart.
- Fail a run with `extension.fail(diagnostic, failureCode)`. Applicant-fixable problems are `Issues`
  findings, not extension failures.
- Send credentials only over clients created with `redirect: "error"`.
- Call an external provider only through its SDK, and test against its stateful simulator
  (`packages/<provider>-simulator`), which the SDK's scenarios check against the provider's sandbox
  ([External provider SDKs](#external-provider-sdks)).
- Sphere's own services, and Sumsub and Vantage until they move to provider SDKs, use generated
  clients. Their simulator packages implement the generated client's API (`SftApi` in
  `packages/sft-simulator/src/provider.ts`) with `packages/provider-simulator`, so they accept exactly
  what the client can send, and serve a control port that integration tests use to script responses
  (`test/integration/helpers/sft.ts`).

## Generated clients and OpenAPI

Use the repository generators for migration snapshots, OpenAPI documents, and clients
(`bun run db:generate`, `bun run gen:clients`).

- `apps/api/src/api.ts` is the API contract. Every endpoint needs an `ApiVisibilityAnnotation` of
  `public` or `internal`; OpenAPI generation fails without one.
- Endpoint and schema meaning goes in `description` annotations, not comments; they become the
  published documentation. Document a caller obligation about a schema input on the service that
  accepts it.
- Clients for Sphere's own services, and for Sumsub and Vantage until they move to
  [provider SDKs](#external-provider-sdks), are generated from the committed snapshot in
  `packages/<name>-client/spec/` by
  `bun run gen:clients`; the package's own scripts trim the snapshot first (for example
  `packages/sft-client/scripts/prepare-spec.ts`). Generated files are git-ignored; never edit them.
  Change a snapshot only by refreshing it from its source, as the README's Generated clients section
  says.

## External provider SDKs

Every external provider gets a [Distilled](https://distilled.cloud)-style SDK in
`packages/<provider>/` and a stateful simulator in `packages/<provider>-simulator/`, built with the
procedure in [Integrating an external provider](providers/README.md). `packages/zenus/` and
`packages/zenus-simulator/` are the reference.

- `vendor/` keeps what the provider publishes, verbatim: its API description and, when useful, its
  guides. Scripts in `scripts/` refresh them; record each source and date in `vendor/README.md`.
- `scripts/spec.ts` lists the operations to generate and how they are presented (envelopes, request
  IDs, names). Generate only operations onboarding uses, and add each with the scenario that
  exercises it.
- `patches/*.patch.json` correct the description where the wire differs: nullability, required
  fields, undeclared failures as typed errors with matchers. A patch states its evidence in its
  `description`; never correct the description in `scripts/spec.ts` or in generated code.
- `bun run generate` produces `src/services/`, which is committed and never edited. It uses the
  vendored generator in `packages/distilled-dev/`; the runtime is `@distilled.cloud/core`.
- The rest of `src/` is hand-written: credentials, the protocol, errors and retries. Default to no
  automatic retries for APIs that move money or identities.
- `test/invariants/` covers the hand-written protocol and credentials. `test/scenarios/` runs
  onboarding under `ResponseValidation.strict` against two targets: the provider's simulator in
  `bun run test`, and the provider's sandbox with `bun run test:live` from the package. Each refusal
  the SDK types has a scenario that provokes it.
- `packages/<provider>-simulator/` is a stateful model of the rules the scenarios establish, using
  value domains from the provider's guides and synthetic identifiers, and decoding requests with the
  SDK's operation schemas. It answers anything else with HTTP 501 rather than guessing; model new
  behavior by first adding a scenario that passes against the sandbox. It runs in process
  (`client()`) and over HTTP with a control port for faults, its journal and resets.

## Configuration

- Read settings with `Config` in a `load...Config` effect owned by the subsystem, and validate them
  there with `Config.schema` or `Config.mapEffect`. `AppConfig` in `apps/api/src/config.ts` loads
  them at startup and provides each subsystem's config service. Provider settings are loaded by the
  provider account's `.layer(config)` instead, so only a catalog that builds the account requires
  them.
- An invalid or missing setting stops startup. Provider configs die with a tagged
  `ConfigurationInvalid` whose message names the setting and the rule
  (`apps/api/src/sft/config.ts`); never fall back to a default that would only fail later in a run.
- Secrets are `Config.Redacted` and stay `Redacted` until the request that needs them.
- Base URLs for credentialed providers go through `originOnlyBaseUrl`
  (`apps/api/src/http/base-url.ts`).

## Errors at boundaries

- Construct `Schema.TaggedError` values with `.make(...)`.
- An error a client may see is an `ApiError` class (`apps/api/src/http/api-error.ts`) with its HTTP
  status, a stable `code` and a default `detail`. List its `.Problem` in the endpoint's `error`.
- Translate internal errors to `ApiError`s at the service boundary, with `Effect.catchTags` or
  `Effect.mapError` (`snapshotErrors` in `apps/api/src/workflow/service.ts`). Handlers only call the
  service.
- A broken invariant is a defect: a tagged error with a `reason` literal, raised with `Effect.die`
  or `Effect.orDie`. The HTTP boundary (`apps/api/src/http/middleware.ts`) turns any unexpected
  failure into a problem response with a correlation id and logs it; it never returns the defect's
  text.
- Do not log free-text reasons or plaintext; annotate logs with ids.

## Effect style

Make application operations read as a sequence of meaningful steps. Keep each step's mechanics
cohesive and use native facilities when they directly express the work. Use
[Effect Solutions](https://www.effect.solutions/) as a style reference, adapted to the installed
version.

The preferences in this section are defaults with exceptions, not mechanical bans. A concrete
readability or technical reason can favor another form; an explicitly permitted alternative needs no
justification merely for being different.

Infer application results, including Effect error and requirement channels. Use explicit types for
intentional public contracts; keep generic type machinery in its owning subsystem.

### Effect flow

Prefer named `Effect.fn` and generator bodies for reusable application operations, respecting
deliberate `Effect.fnUntraced` tracing choices. Use `Effect.gen` for inline Effect blocks. Prefer
named yielded results and ordinary statements over `Effect.map`/`flatMap` chains for success-path
sequencing, including small standalone operations.

A short inline callback that directly composes already-named operations can stay compact, for
example `decode: (row) => decodeReviewRow(row).pipe(Effect.flatMap(present))`. Do not introduce a
generator there solely for consistency.

For a simple field projection from a yielded result, prefer destructuring the result and returning
the field over accessing a property on a parenthesized `yield*` expression.

Direct yielded values and yielded object spreads are fine in simple object construction, whether the
object is returned or passed to a function. Examples include
`customers: yield* customers.count(...)` and `...(yield* writeFailureDetails(...))`. Do not
introduce temporaries merely to pull those yields out of the object.

When one yielded operation is the direct positional input to another Effect call inside a generator,
prefer a named intermediate result:
`const row = yield* readReview(...); return yield* present(row);`, rather than
`return yield* present(yield* readReview(...));`. This rule addresses the nested call itself, not a
call whose object argument contains yielded field values or object spreads as permitted above.

The projection and nested-call preferences above concern application operation results; they do not
establish additional rules for service lookups.

### Native facilities

Use `Option.map` and array `filter`/`map` for straightforward data transformations,
`Effect.mapError` for straightforward typed-error translation, and `Effect.forEach` for
straightforward effectful traversal. Do not unpack a Result solely to map an error.

Do not force a combinator at the cost of unnecessary intermediate structures. A local loop that
directly builds a keyed object can be clearer than producing an entries array and then converting
it. Local accumulation is allowed. Preserve execution order, concurrency, failure behavior, and
result order.

### Guards and branches

Prefer early guards for exceptional cases and resolve dependent missing-value checks before
continuing. When no required shared work remains, keep a failure's handling and terminal return
together instead of handling it in a branch and checking the same condition again to choose the
result. This does not prescribe a rewrite when shared work, such as recording every outcome, occurs
between the checks. Avoid carrying missing values through successive ternaries when guard clauses
expose the dependency more directly.

Prefer explicit branches over ternaries that select operations. Simple value ternaries are allowed.
A compact `Option.match` selecting operations is also allowed; do not mechanically convert it into
branches.

Bind locals once. When deriving a value needs guards or several branches, whether by reassigning a
default or by assigning an uninitialized local in each branch, put the derivation in a helper that
returns early and bind its result with `const`. When a branch that produces the value performs a
workflow step, extract that step as an operation named for what it does, declare it beside its use,
and yield it where the branch was, so it stays in the caller's transaction. Value ternaries, `??`,
compact `Option.match`, and local accumulation remain fine.

### Meaningful helpers

Extract a helper when its name makes the calling operation read more clearly as meaningful steps.
Data preparation, decoding, and a transaction-scoped snapshot can be useful steps even with one
caller.

Keep related mechanics together within that helper. Do not extract every field transformation or
expression merely to shorten functions. Judge the clarity gained at the caller against the
indirection and type/API scaffolding introduced. No fixed line count or reuse count decides
extraction.

An inline callback may already name its step clearly through `Effect.fn("Meaningful.operation")`.
Preserve that structure and its contextual parameter inference when extraction would mainly shorten
the enclosing function while requiring a manually restated parameter shape. Do not treat a long,
already-named callback as an extraction finding by itself. A previously unnamed phase can still
justify a typed helper; this is not a ban on parameter annotations.

Preserve the exact transaction/resource boundary, service ownership, error channels, and tracing
behavior. A helper extraction must not quietly change these semantics.

### Declaration locality

Declare local values near their first meaningful use and keep related declarations and consumers
together. Avoid gathering unrelated preparation at the top of an operation.

Proximity is subordinate to correct evaluation order and lifetime. Do not move eager work,
snapshots, service capture, or resource acquisition across effects, branches, or loops merely to
reduce textual distance. This does not establish a fixed ordering for all module-level helpers.

### Effect boundaries

Put the generator directly in `Effect.fn`; use its trailing transformations for behavior that
applies to the whole operation. Avoid an extra function/generator wrapper used only to obtain a
`.pipe` attachment point.

Use local `.pipe` transformations when behavior belongs to one inner operation. Keep a nested
`Effect.gen` when its scope or transaction covers only part of the enclosing operation. If the inner
block covers the entire operation and exists only as a transformation attachment point, prefer the
trailing `Effect.fn` transformation instead. Never widen a narrower boundary solely to flatten
nesting.

### Phase grouping

Keep lookup/guard/unwrap sequences together. Separate larger logical phases with blank lines, rather
than placing a blank line between every statement.

## Comments

- If a reader can determine what something is or does from the code, including its implementation,
  do not comment it. Let names, types, and steps explain the code; do not describe behavior in
  comments.
- On public contracts (exported service interfaces and subsystem or package entry points), document
  only what callers must do that the code cannot show, such as where or when to call, replay or
  ordering requirements, and the meaning of conventions consumed elsewhere. For example, the replay
  note on `extension.method` and the ordering note on `Grants.grant`.
- HTTP API and schema meaning goes in `description` annotations, not comments (see
  [Generated clients and OpenAPI](#generated-clients-and-openapi)).
- Links to external references, such as provider specifications, are allowed. Tool directives are
  not comments for this rule.

## Tests

- Keep tests small, deterministic, isolated, and focused on consequential application guarantees or
  compatibility regressions. Name the failure each test prevents, check existing coverage, and give
  each guarantee one primary owner.
- Tests run on Bun (`bun --bun vitest`), in CI and in the integration test-runner image, as the API
  does in production.
- In-process guarantees live in the owning app or package's `test/invariants/` and use
  `@effect/vitest` (`it.effect`, `assert`). Config tests provide values with
  `ConfigProvider.fromUnknown` (`apps/api/test/invariants/arcadia/config.test.ts`).
- Tests that need real HTTP, database or process boundaries live in `test/integration/` and run
  against the isolated stack from `bun run test:integration`, with providers replaced by simulators.
  `test/e2e/` runs against Sumsub's Sandbox; read
  [Provider Sandbox tests](providers/sumsub.md#provider-sandbox-tests) before running it.
- Integration files run concurrently, four at a time, against one shared stack; tests within a file
  stay sequential. Every file sees every other file's rows, and cross-tenant readers such as global
  admin stats and document reconciliation read them all, so a file must own its data:
  - Create customers through the API or under an application ID no other file uses. For list or
    count assertions over a whole tenant, use a private application with
    `delegatedHttpClient(applicationId)`.
  - Keep fixed IDs on the shared database unique to the file. Use `workflow/database.ts` for a
    private database when a test reads or counts whole tables.
  - Write complete states with raw SQL: insert an entity and its revisions in one
    `sql.withTransaction`.
  - Give synthetic pending documents a future `created_at`, or document reconciliation fails them.
  - Create shared database objects, such as sequences, in `test/integration/global-setup.ts`.
  - Keep no mutable module state. A file that mocks modules with `vi.mock` must be listed in
    `isolatedFiles` in `vitest.config.integration.ts`, which runs it in its own worker.
- Keep fixtures minimal and local.
- Exploratory probes go in git-ignored `test/smoke/`, `test/integration/smoke/` or `test/e2e/smoke/`
  directories, which no suite runs. Leave them for the user to review; promoting a probe to a
  durable test requires approval, and durable tests must not depend on smoke files.

## Reviews

- Apply the Effect style defaults and explicit permissions above. Report a concrete readability
  improvement, not merely a syntactic difference; cite the applicable default and explain what
  becomes easier to understand.
- Weigh clarity and maintenance benefits against introduced complexity. Group related findings into
  concrete recommendations instead of reporting every manifestation separately. A clean assessment
  is valid; prefer a few persuasive findings to a quota.
- Check the surrounding code before suggesting extraction, reordering, or a combinator rewrite. Do
  not suggest a style-only change whose semantics you cannot account for.
- Do not treat permitted alternatives as violations or invent further rules about type annotations,
  naming conventions, helper declaration ordering, mutation generally, tracing every helper,
  explicit concurrency everywhere, or numeric complexity limits.
- An audit proposes changes; implementation needs a request.
