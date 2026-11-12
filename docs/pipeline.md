# Pipeline operator guide

Pipeline is a thin Effect dispatcher on Athena. The shared worker OpenCode server
owns execution, conversation history, approvals, errors and outputs.
[Capsule](capsule.md) owns source preparation, development environments and the
workspace execution boundary. Pipeline calls Capsule's typed RPC through the
existing authenticated OpenCode server; it never launches a checkout helper or
creates an ordinary-directory session as a fallback.

```text
Limitless caller tools
  → Athena: dispatch outbox, routing index, scheduling budget
      → existing worker OpenCode server
          ├── Capsule RPC → retained checkout + prepared workspace
          └── workspace-bound review session → sandboxed commands and file tools
```

## Ownership and contract

| Owner | Durable information |
| --- | --- |
| Athena | Task routing, command delivery/idempotency, advisory scheduling reservations |
| OpenCode | Native workspace binding, session placement, input messages, execution, history, requests for input, errors and outputs |
| Capsule | Source intent, checkout provenance, runtime lifecycle and execution leases |

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

### Worker Capsule host

```nix
{
  programs.limitless = {
    enable = true;
    capsule = {
      enable = true;
      root = "/home/operator/.local/state/capsule/runtime";
      checkoutRoot = "/home/operator/.local/share/capsule/checkouts";
      controlDirectory = "/home/operator/.local/state/capsule/control";
      github.tokenFile = "/run/agenix/github-token";
      identity = {
        name = "Capsule Agent";
        email = "agent@example.com";
      };
      # Optional: share this existing daemon with trusted project commands.
      dockerSocket = "/run/docker.sock";
    };
    opencode.service.enable = true;
  };
}
```

This configures one Capsule provider in the existing native OpenCode server, not
another worker daemon or an inference server per workspace. The configured
OpenCode wrapper selects Capsule-visible shell and base-tool paths. The worker
must provide a primary `review` agent and use the packaged native host extension.

Pipeline translates PR intent into a source spec: clone the fork at the head
branch and commit, configure the base repository as `upstream` with its base
commit, and verify both `refs/pull/<n>/head` and the fork branch before publishing.
Capsule runs that Git work in its authenticated base sandbox, then loads the
project development shell without injected credentials and runs authenticated
setup. Retained work is not fetched or reset on retry.

The Capsule RPC is registered only at `controlDirectory`, a host-only Location
outside runtime and checkout roots. Its operations are:

| Operation | Responsibility |
| --- | --- |
| `info` | Read capabilities and a fingerprint of the configured storage roots. |
| `prepareSession` | Idempotently reserve the native workspace, create the Capsule, attach its binding, and create the workspace-bound session. |
| `getSession` | Prove retained session ownership and report the Capsule phase and native workspace state without preparing or recreating them. |

Task assignment records the worker origin, control Location, storage fingerprint,
workspace ID, session ID and checkout directory before preparation starts. The
host rejects a changed storage fingerprint. Keep the worker's storage roots
stable; a new root is not recovery of the old workspace.

Review and resume admission require a ready Capsule with a bound workspace.
Interruption, history and exact admission reconciliation require matching retained
identity, not execution readiness. They remain available after stop or purge,
including when the native workspace has been explicitly destroyed. A missing
Capsule manifest or conflicting ownership is still refused.

Capsule owns source and runtime manifests directly. There are no legacy helper
protocols, manifest adoption paths or upgrade conversions. Unknown records are
refused rather than migrated. Logical task close never invokes source archival,
release or Capsule purge.

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
          controlDirectory = "/home/operator/.local/state/capsule/control";
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
| Worker `controlDirectory` | Required; the remote Capsule control Location |

Native events and local outbox changes wake reconciliation. Each task has scoped
in-flight reconciliation, so a long Nix preparation does not block another task's
interrupt or dispatch. Preparation has a 15-minute request deadline; ordinary
native reads and admission requests have 15-second deadlines. These are transport
budgets, not agent execution timeouts. Queue expiry applies only before a command
may have been sent.

Origins require HTTPS, except loopback HTTP for isolated tests. Host configuration
owns ingress, Tailscale and firewall routing. Placement stays pinned; unavailable
workers do not cause automatic reassignment. RPC activation is asynchronous after
native server startup, so readiness uses read-only checks and retries on the
client side.

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

The shared native OpenCode password authenticates worker requests. Capsule's
host-configured GitHub token authorizes cloning and project commands; Athena's
GitHub token is only for PR metadata. Capsule gives trusted commands direct token
access and shares networking, Nix and optional Docker authority with the host.
Its command isolation is not a security boundary against hostile code.

Use protected runtime string paths for secrets, never Nix path literals, store
files, command-line values or task payloads. The native Capsule composition patch
uses the existing workspace machinery and RPC transport; it does not replace the
native server, authentication or database. Retained native admission events can positively confirm an
input cancelled before it became a visible message; absent evidence never proves
that an uncertain request failed.

The dispatcher initializes `dispatch_tasks`, `dispatch_commands`, `dispatch_keys`
and `dispatch_leases`. There is no upgrade or adoption path for older schemas;
never clear live reservations to manufacture recovery.

Core agent shell and file tools use Capsule. Automatic formatting is disabled for
explicit workspace Locations because the upstream formatter and its discovery
probes run on the host. Agents can run a formatter through their Capsule shell.
Client filesystem endpoints, PTYs and file watching remain host-bound; see
[Capsule's scope](capsule.md#scope).

Run `nix run .#checks.x86_64-linux.pipeline` on the host for the packaged native
server integration. The flake build checks validate configuration and coordinator
startup, but cannot exercise Bubblewrap and the host Nix daemon inside the build
sandbox. Fixtures use synthetic credentials, local Git remotes and a loopback
model, not live GitHub or a provider account.

Monitor coordinator queue/delivery uncertainty, held budget, worker connectivity,
OpenCode database/WAL growth, and retained checkout disk use. Native event
retention is server-wide and does not backfill old history. Back up native SQLite
consistently with its WAL and preserve checkouts separately. No automatic TTL,
archive purge, journal pruning, or installed monitoring job is implied.

After API-token rotation, restart the dispatcher and reload caller plugins.
Shared OpenCode-password rotation still requires coordinated managed-server
restarts and client re-pairing. Publication, fleet pin updates, secret provisioning,
ingress and deployment remain separate rollout steps.
