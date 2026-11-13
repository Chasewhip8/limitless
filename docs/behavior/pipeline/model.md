# Pipeline review workflow model

## Scope

This pass covers the retained review interface approved on 2026-11-13: PR-only
submission, fixed continuation, coordinator-owned recovery across conversations,
and operation-specific native final responses. It examines the working tree based
on `bf2deec658d034a46bbc5c7506a2b0af7849facb`, including uncommitted workflow changes.
Validation of this pass is recorded below; it does not describe the live fleet.

The historical pre-removal 49-file source digest is
`e0458e09cbc71ee72c1d9bc058aec5d79bdc449112ff86bc6dbf5726bd45a6e2`.
It hashes sorted relative paths, NUL, file bytes, NUL for `.ts`/`.json` files
beneath `packages/pipeline` and `packages/limitless/tools/pipeline`, plus
`packages/limitless/test/pipeline.test.ts`, `nix/tests/{pipeline.nix,pipeline-runtime.mjs,home.nix}`,
`skills/review-pr/SKILL.md`, and root `package.json`, `bun.lock`, `flake.nix`,
`flake.lock`, `tsconfig.json`. Documentation is excluded from that digest.

The previous Capsule integration baseline was validated on 2026-11-12 against
122 source files with digest
`f940f6d6b91cad7f1a24b4d4f2912dac06fac7a1257b29eed4dee52999a7ce64` and filtered
snapshot `/nix/store/zzcrls7lfzzxrvld2grfhziyrav7yc1n-source`. Its 359 tests and
three host runners passed. That evidence remains historical for Capsule source,
runtime and host composition; this pass does not remap those subsystems.

The native dependency is OpenCode 2.2.7, revision
`fedc6f208aa2bd54c1019227214568083f6380ad`, with the repository's Capsule
composition, durable-event and password-file patches. Native source inspection
on 2026-11-13 established the result-association constraints below. Automatic
cleanup, verdict interpretation, live provider behavior, and proof of global OS
writer termination remain outside scope.

## Model

### Identity and ownership

| Entity | Identity and authority |
| --- | --- |
| Current review | GitHub base repository ID plus PR number maps to one retained task, shared across callers. Restart advances this mapping. |
| Operation | Existing command UUID, passed opaquely by callers. Initial review and continuation are message operations; interrupt is an internal control command. |
| Retained task | Worker origin, control Location, storage fingerprint, workspace, session and checkout. Open/Closed controls submissions, not native execution. |
| Delivery | Pending, Unconfirmed, Acknowledged, Rejected or CancelledBeforeSend. Owned by Athena's outbox. |
| Native execution | OpenCode owns queued prompts, steps, background jobs, input requests, history and responses. Athena reads these; it stores no copied verdict or transcript. |
| Capsule | Owns source preparation, runtime phase, workspace binding and execution leases. Identity proof is distinct from executable readiness. |

[`workflow.ts`](../../../packages/pipeline/workflow.ts) defines the public view;
[`tasks/store.ts`](../../../packages/pipeline/tasks/store.ts) owns durable
identity and transactions. The command UUID indexes its task directly, without
another token or caller receipt subsystem. Deduplication depends on retaining
coordinator records; restoring an older backup can invalidate it.

### Workflow transitions

The service in [`tasks/service.ts`](../../../packages/pipeline/tasks/service.ts)
checks native conditions outside SQL transactions. The store rechecks durable
conditions when committing. Native idleness is not an atomic fence against a
different native client writing directly into the session.

| Action | Preconditions and commit | Recovery |
| --- | --- | --- |
| Review PR | Resolve GitHub identity. Return its current task's latest message operation, including closed or failed work. If absent, require an open PR and usable source; atomically insert task, first command and current mapping. | Always returns current work, which may have advanced. Existing work does not need fresh-checkout eligibility. |
| Continue after operation | Current task's latest operation; open submissions; settled native predecessor, idle native session, ready/bound retained placement; no Pending or Unconfirmed command. Insert the fixed prompt once. | Unique resume/anchor pair returns its original successor before checking conditions, including after later progress. Failed prechecks recheck accepted actions to close concurrent-retry races. |
| Restart after operation | Current/latest anchor, settled native work and no outstanding delivery. Definitively unsent work without earlier acknowledged prompts needs no invented native result. Resolve fresh source, then atomically close predecessor, insert successor and advance mapping. | Successor's initial command retains the restart anchor. Retry never advances twice. Old resources remain. |
| Interrupt after operation | Current/latest anchor, including closed tasks. Definitely unsent input returns NotStarted; Unconfirmed blocks. Otherwise insert one control command. | Same anchor returns its request status. The target remains the waitable message operation, not the interrupt command. |

Continue/restart races have one transactional winner. An
accepted control command also blocks a later action until its delivery settles.
No action accepts arbitrary caller text. The reviewer owns its methodology;
[`tasks/prompt.ts`](../../../packages/pipeline/tasks/prompt.ts) supplies only the
fixed start/continue instructions and original authorization boundary.

### Delivery and retained resources

[`tasks/machine.ts`](../../../packages/pipeline/tasks/machine.ts) remains the
authoritative delivery machine. Pending changes to Unconfirmed **before** a
native write. A native prompt ID and exact body are durable before that boundary.
Only positive acknowledgment or exact retained admission evidence clears
Unconfirmed; idle, missing history, timeout and restart cannot requeue it.
Acknowledgment removes the outgoing body from Athena.

A lost interrupt reply has no native exact command receipt and may remain
Unconfirmed indefinitely. There is no force-resolution API.
Advisory reservations remain held through uncertainty; observing native idle
can release scheduling capacity but does not establish process drainage.

The scheduler still prepares through Capsule's idempotent `prepareSession` RPC.
Message admission requires ready/bound placement. Interruption and history only
require retained identity, so stopped/purged Capsules and an explicitly removed
native workspace row do not force session recreation. Scoped per-task passes
keep slow preparation from serializing unrelated controls.

### Native response association

The accepted queued prompt ID is the lower anchor. Native 2.2.7 has no universal
prompt-to-final-response ID: one execution terminal describes a busy period,
which can contain several queued prompts. Background completion can also wake
another busy period after a foreground success. Queue versus steer is scheduling,
not proof of causal ownership.

[`worker/result.ts`](../../../packages/pipeline/worker/result.ts) folds durable
history rather than selecting the latest assistant message. The result reader
must distinguish the target's own delivery, successfully settled final assistant
step, independent later input, and attributable native continuations. Text parts
of that final message are joined with `\n\n`; reasoning, tool output, failed
partial text and earlier preambles are excluded. A proven final assistant message
without text is CompletedWithoutMessage; missing final-step evidence is unavailable.

Historical target completion takes precedence over later session activity.
Unresolved targets may expose current native input requests. Permission/form
answers remain in OpenCode. Missing history, incompatible evidence and ambiguous
steering must remain unavailable, never fabricate completion or authorize replay.
Finite log replay proves absence only after `log.synced`; the old 100,001-event
absence cutoff is removed. Shutdown preserves a native recovery claim and cannot
authorize continuation or restart merely because the process appears idle.

Native shell and subagent launches are tracked by tool-result identities and
matched to their synthetic completion notices. Outstanding notifications prevent
success; a delivered notice requires a subsequent settled reviewer step. Completed
jobs awaiting notification still count as native activity. Unknown tools or
notices, ambiguous repeated launches, and detached/nested work found in a child
session (including one named by a failed tool call) yield unavailable. A final
step must not require local-tool or output-limit continuation. Recovery followed
by another input before a new step is unavailable rather than a preamble result.

A successful busy period with no outstanding obligations supplies a candidate.
Independent input can close the historical interval. For the current operation,
empty inbox, inactive session and empty background-job snapshots are followed by
incremental replay: new durable events are folded before deciding. Five unstable
snapshot/replay attempts return Pending, not a guessed success. These are native
causal checks, not a prose-based verdict parser. Arbitrary plugins that hide
detached work from native metadata remain outside the supported contract.

### Observation and caller recovery

The authenticated API exposes `/reviews` and `/operations/:operation`; old
task-shaped mutation routes are removed. Caller tools have no local receipt
storage, request hashes, random HTTP keys or receipt-context injection. Mutation
filtering and execution-time primary-agent authorization remain separate guards.

Wait connects directly to scoped NDJSON views, with an immediate heartbeat before
the initial native read and periodic heartbeats thereafter. Healthy waits have no
total timeout; connection failure recovery is bounded. Native evaluations and
readonly continuation/restart preflights have a three-minute total budget, before
any mutation. Caller JSON response deadlines exceed it by fifteen seconds.
A disconnect only detaches the observer,
never interrupts, releases capacity or resubmits. Completed tool content is native
text, with a structured operation view retained separately. Unknown admission
requires repeating exact tool arguments; a later refusal does not prove an
earlier request was never accepted.

## Evidence

| Claim | Basis and status | Reliance / next |
| --- | --- | --- |
| Fixed actions need no caller receipt ledger. | Supported by transactional PR/action identities and store concurrency/restart tests. | Retain coordinator records; backup rollback is outside this guarantee. |
| Native readiness cannot be replaced by dispatch acknowledgment. | Supported by tasks tests covering pending, failed, unavailable, suspended, needs-input and ready/bound conditions. | Continue and restart stay blocked without positive settlement. |
| Delivery uncertainty remains monotonic. | Supported by unchanged transitions and updated scheduler lost-response/lease tests. | No automatic native-send replay. |
| A successful native busy period need not finish the review. | Supported by pinned native source and tests for background completion, terminal jobs awaiting notification, notice/read races, shutdown recovery and unsupported child work. The earlier first-terminal interpretation is contradicted. | Only positively attributable native chains return final text. |
| Native response text can be retrieved without storing it at Athena. | Supported by result unit tests, API exact-text projections and the passing packaged host fixture. | Unsupported or ambiguous native causal chains remain unavailable. |
| Populated legacy state is preserved, not guessed. | Startup refuses conversion; explicit migration tests cover snapshot guards, backups, preservation and reopening. | Migration requires a reviewed mapping and stopped coordinator; unsupported state remains refused. |

Rerun with `nix develop -c bun run ci`, then the host-only Pipeline runner
`nix run .#checks.x86_64-linux.pipeline`. Untracked files require a filtered
`path:<copy>` flake excluding `.git`, `.limitless`, `node_modules`, build-info and
result links; do not stage merely to expose files to Nix. The fixture isolates
HOME/XDG/database, Git remotes, model and credentials. It cannot establish live
GitHub authentication, provider reliability or review quality.

On 2026-11-13, independent final review approved the change after regressions fixed
recovery preambles, repeated helper obligations, failed-child detached work, slow
readiness evaluation, and stalled HTTP error bodies. The 125-test Pipeline/caller
suite passed before the last error-body fix; all 46 caller tests passed afterward,
including both added regressions. Final aggregate validation passed all **395 tests
across 36 files**, and both typechecks passed. Initial host-load timeouts in two
unchanged Capsule tests passed on isolated and aggregate reruns.

All x86_64 Linux flake checks, requested package builds and the packaged Pipeline
host runner passed on `/tmp/opencode/pipeline-review-final.SLS63c`. The runner made
seven fake-model calls and verified exact results, fixed continuation, interruption,
stop/purge retention and logical close. The final caller-only error-body timeout
fix was then included in `/tmp/opencode/pipeline-review-verified.6PbJ91`, which
again passed all x86_64 Linux flake checks and package builds and matches the
49-file digest above. Other platforms and live services were not exercised.

## Checks

### Caller close removal follow-up

Interrupt is now the only caller stop control. The close tool, client method,
public endpoint and Tasks service method are removed; cleanup belongs to future
Pipeline service work. Internal closed-submission state remains for restart.
Review uses `openai/gpt-6.1-sol#max`.

The updated 49-file digest using the scope above is
`d0c97a0e78ada06664de8f82a31ae6ab36dea23a158f071a8b2c2d373ed13db8`.
The agent model file is outside this digest. Follow-up validation passed 367 tests
with 28 environment-dependent tests skipped, both typechecks, and Biome. Focused
caller/API/service coverage passed 57 tests, including absence of the close route.
The native runner now checks retention after interruption, but was not rerun.
Nix development-shell entry timed out; Nix and Markdown lint tools were unavailable
in the ambient shell. Earlier full-build/native evidence above predates this
follow-up and is not a validation of its changed source.

| Check | Status |
| --- | --- |
| Coverage | Applied to review identity, actions, outbox, caller authorization and response attribution. Capsule internals retain their previous baseline. |
| Transitions | Applied to concurrent creation/actions, lost responses, stale anchors, logical close, independent restart, native settlement and supported background causal chains. |
| Boundaries | Applied to SQL commit/recovery, native write-ahead uncertainty and disconnect behavior. No native cross-client execution fence is claimed. |
| Evidence | Applied: final aggregate tests, typechecks, lint, Linux flake/package checks, packaged native integration and independent review passed. Exact source digest and the caller-only follow-up are identified above. |
| Comparison | Applied: workflow identity moved to coordinator; result retrieval added; native busy-period versus final-response distinction corrected. |

## Changes

Compared with the 2026-11-12 Capsule baseline, review identity is global rather
than caller-scoped. Fixed anchored actions replace arbitrary resume requests,
caller hashes/keys and injected receipt context. The stored command UUID is the
public opaque operation. Restart requires current/latest anchors to
protect newer work. Waiting retrieves native results rather than equating idle
with an observed end of work.

The native background-completion limitation is a correction in understanding,
not a new upstream guarantee. Capsule placement and outbox uncertainty remain
separate from execution completion. Ordinary startup refuses populated legacy
databases. The subsequent `pipeline legacy migrate` command supports explicitly
reviewed, fully acknowledged Capsule-backed review chains, with a snapshot guard,
backup, atomic conversion and retained legacy receipt data. See the
[migration procedure](../../pipeline.md#legacy-state-migration). Its independent
review approved the supplied single-review inventory; all 94 Pipeline tests passed.
The historical validation snapshots above predate this migration implementation.
