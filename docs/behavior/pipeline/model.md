# Pipeline dispatch model

## Scope

This model describes the user's approved simplification on 2026-11-11: Athena
dispatches commands; OpenCode owns execution and history; a standalone helper
owns retained checkout files. The pinned native API is OpenCode 2.2.7 at
`fedc6f208aa2bd54c1019227214568083f6380ad`. Validation covered local changes on
base checkout `edb242b08035debb2173b3cd6580438de7766b6b`. Its 61-file source digest is
`4d45a97cdd71f858e92023afad46ce26aa669a869e9de14ae8495e0b8dea4a81`.

The digest hashes sorted relative paths, a NUL, file bytes, and another NUL. Inputs
are `.ts`/`.json` files beneath `packages/pipeline` and
`packages/limitless/tools/pipeline` (excluding `node_modules`); the caller entry
point and Pipeline caller test; the Pipeline/OpenCode modules and packages; the
Pipeline Nix check and runtime fixture; the two retained native patches;
`flake.nix`, `package.json`, `bun.lock`, `tsconfig.json`, and the Limitless package
manifest. Documentation is excluded so recording the digest does not change it.

The user explicitly accepted native observation/interruption semantics rather
than guaranteed process drainage or safe automatic writer handoff. Automatic
cleanup, a result ledger, result submission, and provider cache/session-exhaustion
policy are outside scope. Native workspace providers and their OpenCode patch,
run gates and source overlays have been removed.

## Model

[`tasks/machine.ts`](../../../packages/pipeline/tasks/machine.ts) is the sole
definition of dispatch transitions. This is not a model of OpenCode's executor.

| Machine | Meaning |
| --- | --- |
| Task submissions | Open accepts messages; Closed refuses future messages and cancels those not yet sent. It does not stop native execution. |
| Placement | Unassigned or Assigned to a worker, directory and native session reference. Assignment is not execution status. |
| Delivery | Pending owns checkout/session/send preparation. Unconfirmed records that a write may have been sent. Acknowledged records a positive native reference. CancelledBeforeSend and Rejected concern dispatch only. |
| Reservation | A coordinator-owned advisory session budget. Unresolved delivery holds it; native idle can release it without asserting OS process termination. |
| Caller receipt | Prepared exact request/key becomes Accepted hashes/references after Athena acknowledges. This is not native execution completion. |
| Checkout | The helper's existing explicit filesystem manifest phases. The dispatcher only prepares/inspects and never triggers release. |

### Boundaries

- Pending changes to Unconfirmed transactionally **before** a native mutation.
  Unconfirmed never returns to Pending because input is missing or the session
  appears idle. In-flight and never-received requests cannot safely be
  distinguished by those observations.
- Prompt responses, native inbox entries, delivered messages, and retained
  original admission events provide positive acknowledgment. Cancellation of an
  original input is not permission to reuse its native message ID.
- There is no corresponding exact receipt for a lost interrupt response.
  Such an interrupt stays Unconfirmed, blocking later commands for that task.
  This version has no force-resolution endpoint; investigation can be necessary
  indefinitely. A refusal of a later retry does not disprove an earlier write.
- Acknowledgment removes the outgoing payload from Athena. The hash, command ID
  and native reference preserve idempotency; content and outputs stay in OpenCode.
- Native views are read through and never persisted as execution snapshots.
  Target-message waits do not return idle merely because the session is idle
  before that message is consumed. Native status is a current observation, not
  an immutable task outcome or review verdict.
- Initial session creation is idempotent. Resume requires the existing session
  and original directory; missing native history is never silently replaced.
- Logical close does not revoke already-sent commands, clear their uncertainty,
  release their active reservations, interrupt them, or delete checkout/history.

## Evidence

| Claim | Basis and status | Reliance / next |
| --- | --- | --- |
| Delivery uncertainty is monotonic and blocks replay/followups. | Supported by typed transitions, SQL transactions, and coordinator tests across restart. | Safe dispatch idempotency, not exactly-once model/tool effects. |
| A negative native read cannot fence an earlier request. | Supported by pinned native prompt admission/wake behavior and the earlier admission-rewind counterexample. | Keep Unconfirmed rather than requeueing. |
| Athena removes acknowledged bodies and has no run/result/event ledger. | Supported by the four-table schema and payload-removal tests. | OpenCode remains the content/execution store. |
| Caller scope cancellation has no remote mutation. | Supported by isolated HTTP/clock tests of the caller and event endpoint. | Waiter cancellation only detaches. |
| Native idle/interrupt acknowledgments do not establish process drainage. | Supported by pinned shell-registry removal and detached process behavior. The user accepted this limitation. | No automatic archive/delete or exclusive writer-handoff claim. |
| Real helper/session integration preserves checkout and native history. | Supported by the packaged OpenCode/helper/coordinator fixture: actual read tool, free-form output, restart, resume, native interrupt acknowledgment, logical close and retained files/history. | Native execution observations only; GitHub metadata and model responses are simulated. |

Rerun `bun run typecheck`, `bunx vitest run packages/pipeline/test packages/limitless/test/pipeline.test.ts`, and the flake's `pipeline` check.
Untracked files require a separate Nix source copy (`path:<copy>`), excluding
`.git`, `.limitless`, `node_modules`, build-info files and result links; do not
change the user's index just to expose them to Nix.

Fixtures use isolated HOME/XDG paths, synthetic credentials, local Git remotes,
and a loopback fake model. GitHub metadata in coordinator integration is also
simulated. They prove native orchestration behavior, not provider availability
or review quality. Fixture processes/connections close in finalizers; local
debug directories under `/tmp/opencode/pipeline-*` may remain for diagnosis.

Final validation on 2026-11-11 passed lint, typechecks, 264 repository tests,
20 launcher tests, the full x86_64 Linux flake checks, and package builds. The
packaged integration passed at
`/nix/store/h5bicks7qhlxb8lk34x7r9wjxrb8r9yw-pipeline-check.drv`, exercising
genuine native reads, restart, resume, interruption acknowledgment, payload
removal, and logical close with retained files/history. ARM Pipeline/Home Manager
configurations were evaluated, not runtime-tested. Independent final review
cleared the implementation after the readiness-feedback and receipt-correlation
regressions were fixed.

## Checks

| Check | Status |
| --- | --- |
| Coverage | Applied to outbox, routing, caller receipts, native read-through views and helper preparation. Privileged external mutations remain outside the boundary. |
| Transitions | Applied to acknowledgment, lost replies, cancellation before send, rejected preparation, resume, logical close and restart. |
| Boundaries | Applied to write-ahead dispatch intent, native positive evidence, body removal and scoped waiting. A scheduler feedback regression additionally verifies that full workers are not probed and helper exits do not wake their own readiness retries. |
| Evidence | Source, unit/HTTP tests and real-process fixtures are distinguished; no process-drain guarantee is inferred. |
| Comparison | Applied: the native-workspace/result-ledger design was deliberately replaced, not merely renamed. |

## Changes

The previous implementation duplicated native execution through Run states,
reports and journals, and extended OpenCode to provide workspace/run-control
APIs. The simplified system removes those components. Its stronger safe-handoff
promise was explicitly withdrawn with the user's approval. The remaining
delivery states describe only commands Pipeline sends and what it knows about
their acceptance; they do not compete with OpenCode's execution state.
