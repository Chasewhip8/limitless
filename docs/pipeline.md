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
| Athena | Current review per PR, task routing, command delivery/deduplication, advisory scheduling reservations |
| OpenCode | Native workspace binding, session placement, input messages, execution, history, requests for input, errors and outputs |
| Capsule | Source intent, checkout provenance, runtime lifecycle and execution leases |

Athena has no run ledger, review-report schema, verdict parser, transcript copy,
or execution-event journal. It retains an exact outgoing payload only while
delivery is Pending or Unconfirmed. Positive acknowledgment replaces that payload
with native references. Command IDs and action anchors remain for deduplication.

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

Checkouts and sessions are retained. Interrupt is the only caller stop control.
Cleanup belongs to future Pipeline service work. Guaranteed process drainage,
automatic cleanup, and worker-submitted result APIs are outside this version's scope.

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

Review and continuation admission require a ready Capsule with a bound workspace.
Interruption, history and exact admission reconciliation require matching retained
identity, not execution readiness. They remain available after stop or purge,
including when the native workspace has been explicitly destroyed. A missing
Capsule manifest or conflicting ownership is still refused.

Capsule owns source and runtime manifests directly. There are no legacy helper
protocols, manifest adoption paths or upgrade conversions. Unknown records are
refused rather than migrated. Review operations never invoke source archival,
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
native reads and admission requests have 15-second deadlines. Finite native event
replay has a two-minute deadline. One native-result evaluation or continuation/
restart preflight has a three-minute total budget, ending before outbox mutation.
Caller JSON requests allow three minutes and fifteen seconds. These are transport
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
| Start or recover current review | `POST /reviews` with `{pr}` |
| Read operation | `GET /operations/:operation` |
| Continue retained review | `POST /operations/:operation/continue` |
| Start independent review | `POST /operations/:operation/restart` |
| Request native interruption | `POST /operations/:operation/interrupt` |
| Stream operation | `GET /operations/:operation/events` |

The caller flow is `pipeline_review({pr})`, then `pipeline_wait({operation})`.
The returned operation is opaque. GitHub's base repository ID plus PR number
identifies one current retained review across conversations, repository renames,
and PR head changes. Recovery of an existing review does not require an open PR
or a surviving source fork; identifying it still requires accessible GitHub
metadata. A closed review remains current until explicitly restarted.

`pipeline_continue({after})` sends a fixed prompt to recheck the current head,
findings, and CI in the retained session. It requires the latest operation,
positively settled native work, an idle session, usable placement, open
submissions, and no pending or unconfirmed control/message delivery. Native
permission and form requests must be answered in OpenCode, not by continuation.

`pipeline_restart({after})` explicitly creates an independent review after settled
work, atomically closes predecessor submissions, and advances the PR mapping.
It never interrupts active work or deletes the old checkout or session.
`pipeline_interrupt({after})` returns the targeted operation and the request's
delivery status, not a new assistant-response operation. Definitely unsent work
returns `NotStarted`. There is no caller close or cleanup operation.

All action identities live at the coordinator. Repeat identical arguments after
a lost response. Anchored retries recover the same accepted successor even after
later progress; review submission deliberately returns **current** work. There
are no caller receipt files, idempotency headers, arbitrary continuation messages,
or platform arguments. The old task-shaped routes are removed.

Waiting returns the particular operation's final native assistant text, or a
failure, interruption, cancellation, no-message, needs-input, or unavailable
condition. Completed tool content is the exact final message's text parts joined
with blank lines; earlier tool preambles, reasoning, and tool output are excluded.
Native history determines attribution, not idle or the latest session message.
Concurrent user steering and missing history can make attribution unavailable.
Shutdown remains pending until native recovery settles. Native shell/subagent
completion notices can extend an operation across foreground turns. Unsupported
background tools or detached work inside a child session yield unavailable rather
than an earlier waiting preamble.

Waiting connects directly to scoped NDJSON streams. An immediate blank-line
heartbeat opens the response before native reconstruction, followed by heartbeats
every 15 seconds. A healthy subscription has no total time limit. Two minutes of
consecutive connection failures return unavailable, without implying work failed
to start. Cancelling a waiter only detaches that caller. It does not interrupt,
cancel input, release a reservation, or submit replacement work. The `review-pr`
skill drives this procedure; the review agent owns methodology and verdicts.

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

The dispatcher uses `dispatch_tasks`, `dispatch_reviews`, `dispatch_commands`,
and `dispatch_leases`. On ordinary startup, migration 0002 accepts a fresh or
empty legacy database and **refuses populated legacy state without changing
it**. Do not clear reservations, discard caller receipts, select among duplicate
PR tasks, or reset delivery uncertainty to make the new version start. Upgrade
caller and coordinator protocols together after the state migration below.

### Legacy state migration

`pipeline legacy migrate` runs migration 0002 with a reviewed plan instead of
the refusal. It converts only open, Capsule-assigned tasks whose commands are a
review followed by resumes, each anchored on its predecessor and acknowledged as
its Pipeline message in the assigned session, with no held leases. Anything
else, including pending or unconfirmed deliveries, interrupts, closed or
unassigned tasks, placement on an unconfigured worker, or any change since the
plan was reviewed, fails and rolls back the migration transaction, leaving the
database unchanged.

Conversion preserves task, command and native identifiers, positions, anchors,
versions, timestamps and placement. Records keep their legacy request and
request-hash fields; each task gains the review key from the plan, which maps it
as current, so its latest resume is the next continuation anchor. The canonical
legacy snapshot, including caller idempotency keys, is archived in
`dispatch_legacy_snapshots`. It holds no prompts, because pending payloads are
refused.

1. Stop every coordinator using the database: `systemctl --user stop pipeline`.
   A newly deployed coordinator that starts first only refuses and retries; stop
   it the same way.
2. Inspect the stopped database with the new package. This opens it read-only and
   prints the snapshot digest with task, command and delivery identifiers:

   ```sh
   pipeline legacy inspect --config ~/.config/pipeline/config.json
   ```

3. Write a plan mapping every listed task to its PR base repository's numeric
   GitHub ID and review key, `repositoryId:number`:

   ```json
   {
     "format": "pipeline-legacy-migration/1",
     "snapshot": "sha256:<inspected digest>",
     "reviews": [
       {
         "taskId": "<task id>",
         "repositoryId": 1158510034,
         "reviewKey": "1158510034:2"
       }
     ]
   }
   ```

4. Migrate with a new backup path. The command takes an online SQLite backup,
   converts in one transaction, reopens the database as startup does, and prints
   each review's current operation and the outstanding work list, which should be
   empty:

   ```sh
   pipeline legacy migrate --config ~/.config/pipeline/config.json \
     --plan ./pipeline-plan.json \
     --backup ~/.local/state/pipeline/pipeline-legacy-backup.sqlite
   ```

5. Start the coordinator: `systemctl --user start pipeline`.

Rerunning `migrate` after conversion reopens and reports without another backup.
A refused run reports why; its backup file remains and a retry needs a new path.

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
