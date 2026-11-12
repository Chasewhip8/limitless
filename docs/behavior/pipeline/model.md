# Pipeline dispatch model

## Scope

This model covers the clean Capsule integration approved on 2026-11-12: Athena
owns dispatch and routing, Capsule owns retained source and the execution
environment, and OpenCode owns workspaces, sessions, execution and history. The
baseline is the helper-based model validated on 2026-11-11; its source digest was
`4d45a97cdd71f858e92023afad46ce26aa669a869e9de14ae8495e0b8dea4a81`.

The implementation is the current working tree on commit `2fef97e`, including
uncommitted Capsule and Pipeline changes. Its 122-file source digest is
`f940f6d6b91cad7f1a24b4d4f2912dac06fac7a1257b29eed4dee52999a7ce64`.
The digest hashes sorted relative paths, a NUL, file bytes and another NUL. Inputs
are:

- `.ts`/`.json` beneath `packages/pipeline`, `packages/capsule` and
  `packages/limitless/tools/pipeline`, excluding `node_modules`;
- `packages/limitless/index.ts`, `packages/limitless/package.json` and
  `packages/limitless/test/pipeline.test.ts`;
- Nix modules `home`, `capsule`, `pipeline`, `opencode` and `service`;
- Nix packages `capsule`, `pipeline`, `limitless`, `opencode`, `opencode-bun`,
  plus the `opencode-capsule.ts` bridge;
- Nix checks `capsule`, `pipeline`, `opencode-capsule` and their
  `validate-capsule.mjs`, `pipeline-runtime.mjs`, `validate-opencode-capsule.mjs`
  fixtures; all `nix/patches/opencode-*.patch` files;
- root `flake.nix`, `flake.lock`, `package.json`, `bun.lock` and `tsconfig.json`.

Documentation is excluded so recording validation does not change the digest.
Every input matches the checked filtered source snapshot
`/nix/store/zzcrls7lfzzxrvld2grfhziyrav7yc1n-source`.

The native host is OpenCode 2.2.7 at
`fedc6f208aa2bd54c1019227214568083f6380ad`, with the repository's
[Capsule composition patch](../../../nix/patches/opencode-capsule.patch), event
persistence and password-file patches. Stock 2.2.7 HTTP sessions do not expose
workspace placement; the Capsule RPC captures the host's actual Core services.

The user's clean-cutover decision removes legacy helper protocols, old-manifest
adoption and conversion paths. Genuine borrowed `prepare` remains a Capsule
operation. No live data is deleted or upgraded by this change.

Automatic cleanup, review-result storage, verdict parsing and guaranteed process
drainage inferred from native idle remain outside scope. Capsule routes core
agent shell/file operations; PTYs, client filesystem endpoints and watchers are
not relocated. Host-side automatic formatting is disabled for explicit workspace
Locations before its probes can run.

## Model

[`tasks/machine.ts`](../../../packages/pipeline/tasks/machine.ts) defines dispatch
transitions. Capsule's lifecycle and native execution evolve independently.

| Machine | Meaning |
| --- | --- |
| Task submissions | Open accepts messages; Closed refuses future messages and cancels those not yet sent. It does not stop native execution or purge a Capsule. |
| Placement | Unassigned or pinned to a worker origin, control Location, storage fingerprint, workspace ID, session ID and directory. Assignment is not execution status. |
| Delivery | Pending owns session preparation and send. Unconfirmed records that a native write may have been sent. Acknowledged records positive native evidence. CancelledBeforeSend and Rejected concern dispatch only. |
| Reservation | A coordinator-owned advisory session budget. Unresolved delivery holds it; native idle can release it without asserting OS process termination. |
| Caller receipt | Prepared exact request/key becomes Accepted hashes/references after Athena acknowledges. This is not native execution completion. |
| Capsule | Source intent, runtime phase, generation and optional managed-source provenance. Source preparation has its own retained ledger and per-ID writer lock. |
| Native workspace | Provider and opaque binding, independent of the session referencing it. Destroying the workspace does not erase that session. |

### Preparation and placement

The coordinator persists deterministic workspace/session IDs and the exact source
spec before calling `prepareSession`. PR-to-source translation belongs to
[`worker/source.ts`](../../../packages/pipeline/worker/source.ts); Capsule knows
repositories, refs and commits, not PR semantics.

The initial review moves from Pending `session` to Pending `send`. Resume and
interrupt start at `send`; neither prepares missing resources. Preparation uses
the host's fixed control Location and is idempotent for identical input:

1. Check storage identity and any existing session. A matching session takes a
   read-only validation path, not another setup run.
2. Refuse an operator-stopped or purged Capsule. Reserve the native workspace with
   provider `capsule`, rejecting a conflicting provider before source setup.
3. Create/resume Capsule's source and environment under its existing lifecycle
   rules. The host disables stopped-state resumption; Capsule checks that policy
   under its exclusive lifecycle lock, not only at host preflight. The `creating`
   manifest binds the source intent before provisioning.
4. Attach the prepared Capsule through the native workspace provider.
5. Create the Core session with both the actual directory and workspace ID, then
   validate the returned persisted session. Core may have adopted an existing ID
   before checking the supplied creation arguments.

These steps are not one transaction. Retained phases and repeated exact identities
provide recovery across their commit boundaries. See
[`host/service.ts`](../../../packages/capsule/src/host/service.ts),
[`Capsule service`](../../../packages/capsule/src/service.ts) and the
[native bridge](../../../nix/packages/opencode-capsule.ts).

### Identity is not readiness

`getSession` proves the session ID, caller owner, native workspace identity and
directory against a retained Capsule manifest. A present native workspace must
have the expected provider and matching non-null binding. An absent row or null
binding is reported as an observation, never recreated. A missing Capsule
manifest or conflicting ownership is refused.

The response reports `capsulePhase` and `workspaceState` (`bound`, `unprovisioned`
or `absent`). These are live observations, not new Pipeline-persisted execution
states. The two predicates are distinct:

- Review/resume admission requires phase `ready` and workspace `bound`.
- Interrupt, exact admission reconciliation and history observation require
  retained identity only. They remain valid after stop or purge, including after
  native workspace destruction while its session and Capsule tombstone remain.

Capsule inspection reads an atomically published manifest without taking an
execution lease, so a blocked teardown hook does not block control validation.
The snapshot never authorizes execution: connect and every spawn acquire leases
and recheck phase. Stop may race an admission preflight; a prompt already
attempted still follows the Unconfirmed rules below.

### Dispatch uncertainty

- Pending changes to Unconfirmed transactionally **before** prompt or interrupt
  delivery. Unconfirmed never returns to Pending because input is missing, the
  Capsule stopped, or the native session appears idle.
- Prompt responses, native inbox entries, delivered messages and retained original
  admission events provide positive acknowledgment. Cancellation of an original
  input does not authorize reusing its message ID.
- A lost interrupt response has no corresponding exact receipt. It remains
  Unconfirmed and blocks later commands for that task; investigation may be
  necessary indefinitely. There is no force-resolution endpoint.
- Acknowledgment removes Athena's outgoing body. Hashes, command IDs and native
  references preserve idempotency; content and outputs remain in OpenCode.
- Target-message waits do not report idle until the acknowledged input has been
  consumed or cancelled. Native status is a current observation, not a permanent
  task outcome or review verdict.
- Logical close never clears delivery uncertainty, interrupts work, stops a
  Capsule, or deletes source/history.

### Scheduling and process ownership

The production scheduler has scoped per-task reconciliation, coalescing wake-ups
while a pass is active. A long preparation therefore does not serialize unrelated
task controls. Placement claims and SQL capacity/version checks still arbitrate
the advisory budget. Preparation has a 15-minute full-response deadline;
ordinary native operations use 15 seconds. These are request budgets, not model
execution timeouts. See [`scheduler.ts`](../../../packages/pipeline/scheduler.ts)
and [`worker/client.ts`](../../../packages/pipeline/worker/client.ts).

Capsule lifecycle mutation takes an exclusive lease; commands take shared leases.
The source engine separately holds one exclusive per-ID lock outside its source
directory. The parent retains it between commands, and Git writers inherit the
same locked description through the short-lived Node launcher. Source writers
can therefore keep stop/purge busy after a creator dies. The removed root lock
served only the old helper interlock and has no current role.

## Evidence

| Claim | Basis and status | Reliance / next |
| --- | --- | --- |
| Delivery uncertainty is monotonic and blocks replay/followups. | Supported by typed transitions, SQL transactions and scheduler restart/lost-response tests. | Dispatch idempotency, not exactly-once model or tool effects. |
| A negative native read cannot fence an earlier request. | Supported by pinned admission semantics and the earlier admission-rewind counterexample. | Keep Unconfirmed rather than requeueing. |
| Preparation and session adoption preserve exact placement. | Supported by Capsule host tests, the native composition check and packaged Pipeline fixture. | Validate actual Core workspace placement, not descriptive metadata or an ordinary directory. |
| Control and history survive runtime stop/purge. | Supported by host/worker/scheduler tests and the native fixture stopping during a blocked model request, then interrupting; purging and removing the workspace row preserve history without recreation. | Ownership proof stays separate from message-admission readiness. |
| Slow preparation does not starve another task's interrupt. | Supported by the production-run-loop scheduler regression; serializing the loop makes it fail. | Scoped per-task work and service shutdown cancellation. |
| Source exclusion survives process death without permanent child retention. | Supported by Node/Bun death, cancellation, descriptor-reuse and reclamation tests. | One per-ID inherited lock; no old-helper root coordination. |
| Agent file/shell work uses Capsule and avoids host formatting. | Supported by native shell namespace/private-home checks, host-file denial, genuine agent writes, and workspace/local formatter controls. | Narrow core-agent boundary; not all native APIs or plugins. |
| Athena has no execution/result journal. | Supported by the current four-table schema and payload-removal tests. | Native OpenCode remains the content/execution store. |
| Native idle and interrupt acknowledgment do not establish global process drainage. | The pinned native contract and the user's accepted limitation remain applicable. Capsule adds command leases, not a claim about all Docker/host writers. | No automatic archive/delete or writer handoff. |

Repeat with `nix develop -c bun run ci`, then run the host-only runners
`nix run .#checks.x86_64-linux.opencode-capsule`,
`nix run .#checks.x86_64-linux.pipeline`, and
`nix run .#checks.x86_64-linux.capsule`. Untracked source files require a filtered
`path:<copy>` flake excluding `.git`, `.limitless`, `node_modules`, build-info and
result links; never stage files merely to expose them to Nix.

The native fixtures use isolated HOME/XDG/database paths, synthetic credentials,
canonical GitHub URLs redirected to a loopback Git daemon, input-free Nix flakes
and a fake model. Coordinator GitHub metadata is simulated. They establish
orchestration and execution placement, not live GitHub authentication, provider
availability or review quality. Fixtures close processes/connections in cleanup.
The Pipeline fixture retains its reported directory on failure for diagnosis;
the Capsule and native-host fixtures remove theirs even on failure.

Final validation on 2026-11-12 passed lint, both typechecks, all 359 tests across
33 files, the x86_64 Linux flake checks, and all requested package builds. The
three packaged host runners (`capsule`, `opencode-capsule`, `pipeline`) passed
against the matching source snapshot. Pipeline's native fixture reported seven
model calls and confirmed sandboxed execution, restart/resume, interruption after
stop, retained history after purge and workspace-row removal, and logical close.
Independent final review cleared the implementation after the atomic no-resume,
declared control-address and caller-bundle boundary fixes.

ARM Linux's Pipeline check and OpenCode derivations, and ARM macOS's OpenCode
derivation, evaluated successfully but were not runtime-tested. Intel macOS
evaluation is blocked by the unchanged Nixpkgs pin, which has dropped
`x86_64-darwin`; this is not a Capsule integration regression. Live GitHub,
Docker/OrbStack and fleet rollout were not exercised.

The 2026-11-11 baseline's 264-test/helper integration result remains historical
evidence for that earlier design, not validation of the current native Capsule
boundary.

## Checks

| Check | Status |
| --- | --- |
| Coverage | Applied to dispatch, placement, host RPC, source/runtime ownership, native binding and caller receipts. PTY/client filesystem relocation and live-provider authentication are outside scope. |
| Transitions | Applied to preparation/retry, positive acknowledgment, lost replies, pre-send cancellation, stopped/purged controls, resume, close and host restart. |
| Boundaries | Applied to write-ahead intent, idempotent resource preparation, per-task concurrency, atomic snapshots and inherited writer locks. |
| Evidence | Applied: source, fake-port/unit tests and real native-process fixtures are distinguished. The final 122-file digest matches the source used for aggregate/package/host validation. Cross-platform evaluation and live-provider gaps are stated above. |
| Comparison | Applied: helper preparation and ordinary-directory sessions are replaced by Capsule-owned preparation and explicit native workspace placement. |

## Changes

Compared with the 2026-11-11 helper baseline, checkout preparation is folded into
the idempotent session-preparation operation. Source and runtime lifecycle belong
to Capsule; Pipeline no longer owns a helper protocol or filesystem-status DTO.
Native workspace placement returns through the Capsule composition boundary,
without restoring the former run gates, result ledger or verdict protocol.

The unchanged distinction is dispatch versus execution: Pipeline records what it
intends to send and what it can positively confirm, while OpenCode owns actual
execution and history. The new distinction is retained session identity versus
current executable readiness. Neither is a migration or adoption mechanism.
