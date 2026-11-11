# Pipeline operator guide

Pipeline is a thin Effect dispatcher on Athena. Existing worker OpenCode servers
own execution, conversation history, approvals, errors, and outputs. A short-lived
helper prepares independent Git checkouts through the native shell API; sessions
use ordinary directory locations. There is no native workspace provider,
Pipeline-specific OpenCode patch, source injection, or separate worker daemon.

```text
Limitless caller tools
  → Athena: dispatch outbox, routing index, scheduling budget
      → existing worker OpenCode server
          ├── pipeline workspace helper → retained Git checkout
          └── native review session → messages, execution and outputs
```

## Ownership and contract

| Owner | Durable information |
| --- | --- |
| Athena | Task routing, command delivery/idempotency, advisory scheduling reservations |
| OpenCode | Input messages, execution, history, requests for input, errors and outputs |
| Worker helper | Checkout ownership and filesystem lifecycle manifest |

Athena has no run ledger, review-report schema, verdict parser, transcript copy,
or execution-event journal. It retains an exact outgoing payload only while
delivery is Pending or Unconfirmed. Positive acknowledgment replaces that payload
with native references; request hashes and command IDs remain for idempotency.

`Idle` is a current OpenCode observation, **not** a permanent task outcome or a
proof that every OS process has stopped. An acknowledged interrupt means the
native request was received, not that all descendants or filesystem writers have
terminated. Capacity is an advisory budget for Pipeline sessions, not an OS
resource limit or exclusive ownership of a PR branch.

An ambiguous write remains Unconfirmed. Missing history, native idle, a timeout,
or a coordinator restart does not authorize replay. Such a command blocks later
commands for that task and holds its scheduling reservation. There is deliberately
no automatic recovery that guesses a lost write failed. An unconfirmed interrupt
has no native command receipt to look up and can remain unresolved indefinitely;
manual investigation is required, and this version has no force-resolution API.

Checkouts and sessions are retained. Logical close disables future messages and
cancels messages not yet sent; it does not interrupt in-flight work or archive,
delete, or revoke a native session. Guaranteed process drainage, automatic
cleanup, and worker-submitted result APIs are outside this version's scope.

The [dispatch model](behavior/pipeline/model.md) records the explicit delivery
states and the boundary between dispatch acknowledgment and native observation.

## Configuration

### Worker helper

```nix
{
  programs.limitless.pipeline.worker.enable = true;
}
```

This only installs `pipeline`, with pinned Node, Git, tar, flock and coreutils.
It starts no service and does not require the hosted Limitless module. Separately
enroll the worker's existing OpenCode 2.2.7 server with a primary `review` agent.
Use a dedicated checkout root containing no unrelated work.

`pipeline protocol` reports helper protocol 2. The helper accepts prepare and
inspect requests through `pipeline workspace --root ... --request ...`. Preparing
an already retained checkout does not reset it or require its original remote
head to remain current. Ownership validation, process locking and release
tombstones remain in the filesystem library. Archive/release operations are not
exposed by the CLI or used by the dispatcher; they require independently verified
writer quiescence before any future operator integration uses them.

### Athena

The standalone `homeModules.pipeline` module can run without hosted Limitless.

```nix
{
  programs.limitless.pipeline = {
    enable = true;
    settings = {
      apiTokenFile = "/run/agenix/pipeline-api-token";
      githubTokenFile = "/run/agenix/github-token";
      workers = [
        {
          id = "personal-vm";
          url = "https://personal-vm.example.ts.net";
          credentialFile = "/run/agenix/opencode-password";
          workspaceRoot = "/home/operator/pipeline-workspaces";
          helperExecutable = "/home/operator/.nix-profile/bin/pipeline";
          system = "aarch64-linux";
        }
      ];
    };
  };
}
```

| Setting | Default |
| --- | --- |
| `host`, `port` | `127.0.0.1`, `4848` |
| `database` | `${xdg.stateHome}/pipeline/pipeline.sqlite` |
| `apiTokenFile` | `${xdg.configHome}/pipeline/api-token` |
| `githubTokenFile` | `null` |
| `pollIntervalMs` | `60000`: safety reconciliation |
| `queueTimeoutMs` | `3600000`: unsent command queue budget |
| Worker `capacity` | `1`, advisory Pipeline-session budget |
| Worker `openCodeVersion` | `2.2.7` |
| Worker `helperExecutable` | `${home.profileDirectory}/bin/pipeline` |

Native events and local outbox changes also wake reconciliation. Helper command
completion is observed through native shell events, not a model polling loop.
There is no execution timeout or automatic timeout-to-stopped transition in
Athena. Queue expiry applies only before a command may have been sent.

Origins require HTTPS, except loopback HTTP for isolated tests. Host configuration
owns ingress, Tailscale and firewall routing. The worker URL, checkout directory
and session stay pinned; unavailable workers do not cause automatic reassignment.

### Calling agents

```nix
{
  programs.limitless = {
    enable = true;
    pipeline.client = {
      enable = true;
      url = "https://athena.example.ts.net:10443";
      tokenFile = "/run/agenix/pipeline-api-token";
    };
  };
}
```

Mutation tools require the primary `limitless` agent at execution time. The
endpoint and credential file are fixed configuration, not tool arguments.

## API and tools

Every endpoint, including health and streams, requires the separate Pipeline
bearer token.

| Operation | Endpoint |
| --- | --- |
| Dispatch review | `POST /tasks` with `Idempotency-Key` |
| Task index and live native view | `GET /tasks/:id` |
| Append a message | `POST /tasks/:id/resume` with `Idempotency-Key` |
| Request native interruption | `POST /tasks/:id/interrupt` with `Idempotency-Key` |
| Command receipt and native view | `GET /tasks/:id/commands/:commandId` |
| Stream that view | `GET /tasks/:id/commands/:commandId/events` |
| Logically close submissions | `POST /tasks/:id/close` |

Initial submission remains the PR-review entrypoint:
`{kind:"review",pr,system?}`. Resume takes `{afterCommandId,message}` and interrupt
takes `{afterCommandId}`. The anchor identifies caller intent and must belong to
the task; it is not a run, result, or completion prerequisite. OpenCode retains
the actual message. Resume never recreates missing session history or resets the
checkout. The review agent owns all review stages and its response format.

The tools are `pipeline_review`, `pipeline_resume`, `pipeline_wait`,
`pipeline_interrupt`, and `pipeline_close`. Dispatch returns task/command IDs;
acceptance by Athena is distinct from acknowledgment by OpenCode.

Caller receipts preserve the exact request and key before a POST. Accepted
receipts retain hashes and references, not message bodies. A lost response,
including a later refused retry, never causes an automatic fresh key. The same
caller session/PR recovers its existing review; use `afterTaskId` explicitly for
a fresh task or `afterCommandId` for another message/control request.

Waits observe a particular command and its native session. They do not report a
verdict or retrieve the assistant's output. Open that session in OpenCode for
its history. Acknowledged input must have been consumed/cancelled before idle
can satisfy a target-message wait; idle before admission is not completion.

Waiting uses scoped NDJSON streams with 15-second blank-line heartbeats and
reconnection. The default wait has no total time budget; a positive `timeoutMs`
returns the last pending view when its budget expires, and zero reads once.
Cancelling a waiter only detaches that caller. It does not interrupt work,
cancel input, release a reservation, or submit a replacement.

## Credentials, storage and operations

The shared native OpenCode password authenticates worker requests. Git cloning
uses the worker's existing Git/`gh auth git-credential` configuration; Athena's
GitHub token is only for PR metadata. A submission is the trust boundary: trusted
repository code runs with the worker user's access. This is not a sandbox.

Use protected runtime string paths for secrets, never Nix path literals, store
files, command-line values or task payloads. The previously approved native
event-persistence and password-file patches remain separate from Pipeline's
helper integration. Retained native admission events can positively confirm an
input cancelled before it became a visible message; absent evidence never proves
that an uncertain request failed.

The dispatcher uses `dispatch_tasks`, `dispatch_commands`, `dispatch_keys` and
`dispatch_leases`. Earlier unshipped experimental tables are not adopted or
deleted. Account for any old experimental work before switching an existing
database; do not clear live reservations to manufacture recovery.

Monitor coordinator queue/delivery uncertainty, held budget, worker connectivity,
OpenCode database/WAL growth, and retained checkout disk use. Native event
retention is server-wide and does not backfill old history. Back up native SQLite
consistently with its WAL and preserve checkouts separately. No automatic TTL,
archive purge, journal pruning, or installed monitoring job is implied.

After API-token rotation, restart the dispatcher and reload caller plugins.
Shared OpenCode-password rotation still requires coordinated managed-server
restarts and client re-pairing. Publication, fleet pin updates, secret provisioning,
ingress and deployment remain separate rollout steps.
