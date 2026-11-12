# Capsule guide

Capsule runs commands for a retained source checkout inside its Nix development
environment, through Bubblewrap. It is a small Effect library and CLI. It keeps
per-task state between commands so work can stop and resume, and it can expose an
existing host Docker daemon to the checkout's commands.

A Capsule either **borrows** a checkout the caller already has (`prepare`) or
**manages** a full GitHub clone that it creates itself (`create`). Commands in
either kind can receive host-configured GitHub credentials.

Capsule is development hygiene for **trusted** code, not a security boundary.
Commands share the host network, the Nix daemon and any exposed Docker daemon.
Docker socket access grants the authority of that daemon: typically root for a
rootful daemon, or its owning user for a rootless daemon. Configured GitHub
credentials are readable by every command. Isolation covers only the operations
routed through Capsule; see [Scope](#scope).

## Status

| Area | State |
| --- | --- |
| Core service and `capsule` CLI | Implemented for `x86_64-linux` and `aarch64-linux` |
| Managed sources (`create`) and source engine (`@limitless/capsule/source`) | Implemented |
| Host-configured GitHub credentials | Implemented; see [GitHub credentials](#github-credentials) |
| OpenCode workspace provider (`@limitless/capsule/opencode`) | Implemented against the published `@opencode/sdk` `2.2.7` Effect SDK |
| Native OpenCode host registration | Configured with `programs.limitless.capsule.enable` in the shared native server |
| Pipeline | Uses Capsule RPC to prepare a workspace-bound native session; no checkout helper or ordinary-directory fallback |
| Preview environments | Deferred |

## Ownership

| Owner | Responsibility |
| --- | --- |
| Capsule | Identity, lifecycle phases, private home and temporary directories, the Bubblewrap command boundary, the lifecycle lock, and, for managed Capsules, the clone, its source ledger and source lock |
| Repository | Its flake development shell and optional `capsule.json` hooks that start, stop and purge its services |
| Caller | Borrowed checkouts, a unique Capsule ID per task, the state and checkout roots, credential configuration, and the decision to stop or purge |
| Docker daemon | Containers, volumes, networks and images, scoped only by the repository's own naming |

Capsule never creates, moves or deletes a borrowed checkout. It creates a managed
checkout once and afterwards never resets, fetches into, or deletes it. Capsule
never starts a Docker daemon.

## Scope

Each command gets new mount and PID namespaces. Inside, it sees:

- the checkout, read-write, at its real path;
- private `HOME`, XDG configuration/cache/state, `TMPDIR` and runtime directories,
  with the private temporary directory also mounted at `/tmp`;
- `/nix/store`, the Nix daemon socket and database, and selected `/etc` network
  and Nix files, read-only;
- the Docker socket given to `prepare` or `create`, if any.

For ordinary linked Git worktrees and separate gitdirs, Capsule also exposes the
gitdir and common Git metadata directory read-write at their existing paths.
Those are borrowed resources: purge never removes or unregisters them. Worktrees
continue to share Git objects, references and configuration; Capsule does not
isolate Git operations from the other worktrees of that repository. External
object alternates and unusual symlinked Git layouts are not covered. Managed
checkouts are standalone clones with their own `.git` directory.

The host process environment is never inherited. Host home directories, SSH
agents and credential files outside these mounts are not visible. The only host
secrets a command receives are the [GitHub credentials](#github-credentials) its
host configures.

Capsule does not isolate the network, CPU or memory, the Nix daemon, or Docker.
In an OpenCode workspace, agent shell commands and the agent's file tools use the
provider; OpenCode implements file operations through sandboxed GNU commands.
Client-facing filesystem endpoints, PTY terminals and file watching still use
host paths. Automatic formatting is skipped for explicit workspace Locations,
before host formatter discovery or execution; agents can run formatters through
their Capsule shell. This is not a unified private filesystem view for every
native API or plugin.

## Build and verify

```sh
nix build .#capsule
nix run .#checks.x86_64-linux.capsule
# On ARM Linux, use checks.aarch64-linux.capsule instead.
```

The package wraps the CLI with `CAPSULE_RUNTIME_CONFIG`, a pinned runtime JSON
(also installed at `share/capsule/runtime.json`) naming Bubblewrap, Bash, `env`,
Nix, `flock`, `gh`, Node, CA certificates and a base `PATH` of shell, Git, `gh`,
ripgrep, Nix and Docker client tools. Node only supervises source locks and is not
on the base `PATH`; language runtimes, including Node, come from the project's
development shell. The package contains no GitHub credentials.

The flake check builds the package and validates its runtime without namespaces,
because build sandboxes cannot create user namespaces or reach the Nix daemon.
Run the check's `validate-capsule` runner on the host, as above, to exercise real
Bubblewrap, managed cloning, runtime credentials, lifecycle hooks and purge
tombstones. Its temporary Git transport redirects canonical GitHub URLs to a
loopback fixture; no credentials enter the Nix store.

The Vitest suite covers the source engine against local fixture Git remotes,
including resumption, ref pinning, path safety and kernel source locks across
supervisor `SIGKILL`. Credential tests use synthetic tokens and a stand-in `gh`
to check token rotation, variable precedence and Git helper configuration.
A separate source-lock test checks that every provisioning
command passes through the command hook with freshly read credentials.

With `CAPSULE_TEST_RUNTIME` set, the managed-creation tests run `create` through
real Bubblewrap and the Nix daemon against a loopback Git daemon and a fixture
flake without inputs. They cover:

- a full-history clone on its own branch at the expected commit, with `setup`
  running in the development shell;
- refusal of a moved ref and of unsafe checkout roots before cloning;
- retention of committed, staged, dirty and untracked work across repeated,
  refreshed and offline `create` calls, without resolving an advanced ref again,
  and refusal of a changed request or `capsule.json` for the same ID;
- a failed `setup` that keeps the published source and finishes on retry without
  cloning again;
- stop, resume through `create`, and purge that keeps the source, its ledger and
  the runtime manifest's provenance;
- creator death during a sandboxed Git write: inherited source locks refuse stop
  and purge until the surviving writer finishes;
- a synthetic token file read through the pinned `gh` by `git credential fill`
  and `gh auth token`, its rotation, the configured author identity, and the
  token's absence from persisted state;
- development-shell resolution without injected credentials, followed by
  authenticated setup, project commands and teardown hooks.

The embedded SDK tests provision two managed workspaces in one Bun host before
creating sessions at their checkout paths. They exercise agent file tools and
shell commands, Git commits, host-credential isolation and source retention
after workspace destruction. Source-lock regressions also run with Node and
the pinned development Bun, including forced garbage collection and failed
process startup.

The loopback Git daemon does not authenticate, so these tests do not prove
authenticated cloning of a private GitHub repository. No test contacts GitHub or
uses a real account, and none runs against OrbStack.

## State and checkout roots

Every invocation needs a dedicated absolute state directory, given by `--root` or
`CAPSULE_ROOT`. There is no default. The root must not contain, or be inside, a
checkout. Capsule creates it with mode `0700` and stores:

```text
<root>/<id>/manifest.json    identity, specification, source, generation and phase
<root>/<id>/home             private HOME
<root>/<id>/home/.local/state/capsule   writable CAPSULE_STATE_DIR
<root>/<id>/tmp              private TMPDIR and /tmp
<root>/<id>/run              private XDG_RUNTIME_DIR
<root>/.locks/<id>           lifecycle lock
```

`create` also needs a separate checkout root, given by `--checkout-root` or
`CAPSULE_CHECKOUT_ROOT`. Neither root may contain the other. The checkout root
must be owned by the user and not writable by group or others; Capsule creates its
directories with mode `0700`:

```text
<checkout-root>/<id>/manifest.json   source ledger: request, resolved commit, phase
<checkout-root>/<id>/checkout        published full clone
<checkout-root>/<id>/staging         clone in progress
<checkout-root>/.locks/<id>          per-source lock
```

The source ledger is independent of the runtime manifest and survives purge.
Capsule refuses to adopt a nonempty directory without a manifest, a manifest
belonging to another ID, or control paths containing symlinks or hard links.

## Repository contract

Capsule evaluates `<checkout>#<devShell>` with `nix develop
--no-update-lock-file`, so the checkout needs a flake with a committed, complete
`flake.lock`. In a Git checkout, Nix ignores untracked files, including an
untracked `flake.nix`.

An optional `capsule.json` at the checkout root selects the shell and lifecycle
hooks. Hooks are argument vectors, not shell strings, and run in the checkout
inside the Capsule environment:

```json
{
  "devShell": "default",
  "setup": ["./scripts/dev", "setup"],
  "stop": ["./scripts/dev", "stop"],
  "purge": ["./scripts/dev", "purge"]
}
```

Every field is optional; `devShell` defaults to `default`. Hooks must be
idempotent because an interrupted phase reruns them. For a managed Capsule,
`capsule.json` is read from the published clone, never from the remote before
cloning. Follow the [repository-setup skill](../skills/repository-setup/SKILL.md)
for Compose, port and teardown rules on a shared Docker daemon.

## CLI

Global flags precede the subcommand; each has an environment fallback. Lifecycle
commands print the manifest as JSON, or `null` when the ID has no Capsule.

```sh
capsule --root "$STATE" --checkout-root "$CHECKOUTS" create --id <id> \
  --repo <owner/repo> --ref <branch|tag|full-sha> \
  [--branch <name>] [--commit <full-sha>] [--docker-socket <socket>] [--refresh]
capsule --root "$STATE" prepare <checkout> --id <id> [--docker-socket <socket>] [--refresh]
capsule --root "$STATE" exec <id> [--cwd <dir>] -- <command> [args...]
capsule --root "$STATE" inspect <id>
capsule --root "$STATE" stop <id>
capsule --root "$STATE" purge <id>
```

| Global flag | Environment | Meaning |
| --- | --- | --- |
| `--root` | `CAPSULE_ROOT` | Runtime state root; required |
| `--runtime` | `CAPSULE_RUNTIME_CONFIG` | Pinned runtime JSON; set by the package wrapper |
| `--checkout-root` | `CAPSULE_CHECKOUT_ROOT` | Managed checkout root; required by `create` |
| `--github-token-file` | `CAPSULE_GITHUB_TOKEN_FILE` | Host token file |
| `--github-token-env` | `CAPSULE_GITHUB_TOKEN_ENV` | Name of a host variable holding the token |
| `--git-name`, `--git-email` | `CAPSULE_GIT_NAME`, `CAPSULE_GIT_EMAIL` | Git author and committer identity; give both or neither |

IDs match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` and must be unique across tasks
sharing a Docker daemon, not merely within one state root. `prepare` borrows an
existing directory with its current `capsule.json`. `--docker-socket` must name an
existing Unix socket. `exec` runs in the checkout by default, resolves a relative
`--cwd` against it, and exits with the command's status.

## Managed sources

`create` clones `https://github.com/<owner/repo>.git` as `origin`, which is also
the push URL. `--ref` names a branch, a tag, or a full 40-character commit SHA; a
branch takes precedence over a tag of the same name. The ref is resolved once,
when the source is first created, and that commit is frozen in the source ledger.
`--commit` requires the ref to resolve to that commit, failing with `stale_ref`
otherwise. The commit is checked out on the local branch `--branch`, by default
`capsule-<id>`. Tracking is configured only when the source ref is a branch and
the local branch has the same name. A separate work branch, tag or commit starts
without an upstream, so publishing requires an explicit first push such as
`git push --set-upstream origin task-123`. Ready resumption preserves tracking
that the user subsequently configures.

The clone keeps complete history, ignores system and global Git configuration,
and installs no hooks. It is built in `staging`, configured, verified, and then
published to `checkout` by an atomic rename. Git runs inside Bubblewrap with the
Capsule's private home, the base `PATH` and the configured GitHub credentials,
never the project's development shell. Only after publication does Capsule read
`capsule.json`, evaluate the development shell and run `setup`.

Run the same `create` command to resume. An interrupted clone, configuration or
publication resumes at the frozen commit. A published source is returned as
retained: new local commits, staged, dirty and ignored files are kept, and it is
never fetched, reset or moved. An interrupted clone that already contains local
work, or one where both `staging` and `checkout` exist, is retained and refused
rather than adopted.

The ID is bound as soon as `create` writes its `creating` reservation, before the
ref is resolved or anything is cloned. If ref validation, authentication or the
network then fails, even before a source ledger exists, the ID stays reserved for
that request: retry with identical input, including the same `--commit`,
`--branch`, checkout root and Docker socket. A corrected repository, ref,
expected commit or placement needs a new ID; reusing the reserved one fails with
`ownership_mismatch`.

Source operations try their per-source lock exclusively without blocking: a
concurrent operation on the same ID fails immediately with `busy`, while
different IDs proceed in parallel. Capsule holds the lock while updating source
files and metadata. A short-lived Node supervisor passes the same lock to each
command as descriptor 3, so it stays held until the last Git writer exits even
if Capsule is killed.
`stop` and `purge` of a managed Capsule first try the source lock the same way:
while a source operation or an orphaned Git writer from a crash still holds it,
they fail with `busy` instead of waiting.

## Lifecycle

```text
create → creating → preparing → ready
prepare → preparing → ready ─stop→ stopping → stopped ─prepare/create→ preparing → ready
                        └── purge → purging → removing → purged (tombstone)
```

- **Create** writes a `creating` manifest (owner `limitless-capsule-v2`, with a
  `source` of its checkout root, request and, once published, commit), prepares
  the source, then continues as prepare. Both managed and genuinely borrowed
  Capsules use this one current manifest format; older formats are not adopted
  or converted. `prepare` refuses a Capsule that is still `creating`.
- **Prepare** writes `preparing`, creates the private directories, runs `setup`,
  then writes `ready`. Preparing a `ready` Capsule without `--refresh` returns
  the same manifest without running anything. Creating one verifies the retained
  clone locally, without contacting the remote, and returns the same manifest
  without running hooks.
- **Refresh** (`--refresh`) starts a new generation, reevaluates the recorded
  development shell from the checkout's current flake, and reruns the recorded
  `setup` hook, whose referenced scripts run with their current contents. It
  never changes the source or adopts a different `capsule.json`.
- **Resume**: preparing a `stopped` Capsule reruns `setup` with its retained
  private directories and repository data; use `create` with the same flags for a
  managed Capsule. A failed or interrupted `create`, `prepare` or `stop` remains in
  its intermediate phase; the next call reruns it.
- **Stop** runs the `stop` hook and keeps every directory. Stopping a stopped or
  purged Capsule returns its manifest.
- **Purge** runs `stop` and then `purge` when either hook exists, records
  `removing`, deletes the private home, temporary and runtime directories, and
  leaves a `purged` manifest. An interrupted deletion resumes without reloading
  the deleted environment or repeating completed service teardown. Purge never
  deletes a checkout or source ledger; reclaiming managed checkouts is an operator
  task. Purge retires the ID: it cannot be prepared or created again.
- An ID is bound to an immutable specification: checkout, `capsule.json`
  contents and Docker socket, plus the source request for a managed Capsule.
  Reusing it with a different specification fails with `ownership_mismatch`, even
  with `--refresh`. A managed Capsule records its `capsule.json` settings once,
  when its first `preparing` manifest is written; only a reservation still
  `creating` from before that point reads them afresh.

There is no configuration migration or automatic ownership conversion. To keep
local edits while changing recorded `capsule.json` settings, a manual alternative
is to stop the old Capsule, make sure nothing still writes to its checkout, and
then `prepare` that checkout as a borrowed Capsule under a new ID. Never run two
active Capsules on the same checkout. The source engine keeps owning the checkout
record; the new runtime only borrows it, and the old ID and its source provenance
remain. The old Capsule's private home, Compose volumes and other state do not
carry over.
Keep the old Capsule stopped, or purge it explicitly, coordinating its repository
teardown so it does not race work in the reused checkout.

`create`, `prepare`, `stop` and `purge` take an exclusive lock; each command holds
a shared lock until its execution scope closes. The CLI and OpenCode close that
scope after execution. Nothing waits for the lock: a lifecycle operation during an
active command fails with `LockBusy`, and a command started during a lifecycle
operation is refused. Cancel running commands before stopping, refreshing or
purging.

Every spawn checks the phase under its shared lock. Commands are refused with
`not_prepared` unless the Capsule is `ready`, so after `stop` they fail until an
explicit `prepare` or `create`; nothing prepares automatically during execution. A
command whose lock holder dies is killed.

`inspect` reads a validated, atomically published manifest snapshot without
taking a lifecycle lease. It remains available during setup or teardown, but its
result does not authorize execution: `connect` and every command acquire their
own lease and recheck readiness.

## Environment

A connection evaluates the development shell inside the base sandbox, running
its `shellHook`, without injecting host credentials, Git helper configuration or
Git identity. It captures the complete resulting project environment and caches
it by manifest generation. Commands reuse it until the generation changes, and
the next command after a refresh, or after stop and prepare, evaluates the shell
again. Existing connections, including cached OpenCode workspace connections,
need no manual reconnect. Each `capsule exec` is a new connection.

The environment stays in memory, marked as redacted; Capsule never writes it to
the manifest or state root. There is no credential-stripping pass: project
commands receive Capsule's authentication settings only after environment
resolution. Source operations receive credentials separately in the base
sandbox. Keep `shellHook` fast and idempotent, and put bootstrap work that needs
GitHub access in the Capsule `setup` hook instead.

Capsule then sets the Nix daemon and certificate variables, and reserves the
following variables, which commands cannot override:

| Variable | Value |
| --- | --- |
| `CAPSULE_ID` | The Capsule ID |
| `CAPSULE_STATE_DIR` | `<root>/<id>/home/.local/state/capsule` |
| `COMPOSE_PROJECT_NAME` | `capsule-<hex of the ID>`, unique per ID |
| `DOCKER_HOST` | `unix://<socket>` when a Docker socket is exposed |
| `HOME`, `TMPDIR`, `TMP`, `TEMP`, `TEMPDIR`, `XDG_RUNTIME_DIR` | Private state directories |
| `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` | Configuration, cache and state beneath the private home |

`PATH` starts with the pinned base tools, followed by the development shell's
entries. Credential variables are applied last; see
[GitHub credentials](#github-credentials).

On-disk changes in the checkout are visible immediately. Changes to the flake,
its inputs, or files the shell evaluates take effect after a refresh, or in a new
connection.

## GitHub credentials

The host configures credentials; repositories and `capsule.json` cannot. In the
library, omitting `credentials.github` gives commands no host token. The CLI
always enables GitHub access: it uses `--github-token-file` or
`--github-token-env` when given (they are mutually exclusive), otherwise its own
`GH_TOKEN`, then `GITHUB_TOKEN`. When none is set, commands run without a token,
and private GitHub operations fail instead of prompting.

- A token file must be an absolute, normalized path to a regular file of at most
  64 KiB. It is reread for every execution, so rotation applies without a
  restart. Errors name the source but never its contents.
- A token variable is read through the host process configuration. A long-lived
  embedding host needs a restart to see a rotated value; each CLI invocation is a
  new process.

Source Git operations, project commands and Capsule `setup`, `stop` and `purge`
hooks receive these settings last, over the project environment and command
overrides. Development-shell evaluation and its `shellHook` do not receive them:

| Setting | Value |
| --- | --- |
| `GH_TOKEN` | The current token, when GitHub access is enabled and a token is available; otherwise removed |
| `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` | Removed |
| `GH_PROMPT_DISABLED`, `GIT_TERMINAL_PROMPT` | `1` and `0` |
| Command-scoped Git configuration | With GitHub access enabled, clears other helpers for `https://github.com`, then uses the pinned `gh auth git-credential` |
| `GIT_AUTHOR_*`, `GIT_COMMITTER_*` | Name and email, when an identity is configured |

Git over HTTPS and the `gh` CLI therefore authenticate as the token's owner, with
its full scope; Capsule never runs `gh auth login` or writes `gh` or Git
credential files. Project Git configuration entries from the development shell
are kept ahead of Capsule's. Capsule never puts the token in command arguments,
clone URLs, the Nix store, manifests, the source ledger or the cached environment.

`GH_TOKEN` is deliberately available to trusted project commands. Redaction keeps
it out of Capsule's own errors and serialized data only: any command can read,
print or transmit it, and Capsule does not filter command output. The token is
not a Nix access token, so Nix's GitHub flake fetcher does not use it; private
flake inputs need separate Nix configuration.

## Processes and services

Capsule has no persistent helper. Every command, and each stage of a piped
command, is its own Bubblewrap process with its own PID namespace. When the
command exits, background descendants it started end with it. A foreground
long-running command, such as a development server, runs until it exits or its
caller cancels it. Managed source operations additionally use the short-lived
lock supervisor described in [Managed sources](#managed-sources).

Services that must outlive a command run in the shared Docker daemon. The
repository starts them from `setup` and stops or removes them from `stop` and
`purge`. Capsule does not track containers itself.

## Library

The core layer comes from the main package:

```ts
import * as Capsule from '@limitless/capsule'

const capsule = Capsule.layer({
  root,
  runtime,
  checkoutRoot, // required by create
  credentials: {
    github: { tokenFile: '/run/agenix/github-token' }, // or { tokenEnv }, or {} for the defaults
    identity: { name, email },
  },
})
```

`Capsule.layer` needs `ChildProcessSpawner`, `FileSystem` and `Path`; `runtime` is
the package's runtime JSON decoded with `RuntimeSettings`. The service provides
`create`, `prepare`, `inspect`, `connect`, `stop` and `purge`.
`@limitless/capsule/source` exports the source engine alone. Capsule runs its Git
commands through Bubblewrap and credentials with a command hook. Source commands
carry their environment separately from
the Node helper's environment. The encoded environment entry is limited to
120 KiB; larger entries fail with a sanitized `io_failed` before spawning.

## OpenCode workspace provider

The provider is a separate export that requires the `Capsule` service:

```ts
import { Effect } from 'effect'
import * as Capsule from '@limitless/capsule'
import * as CapsuleWorkspace from '@limitless/capsule/opencode'

const makeWorkspace = Effect.gen(function* () {
  const capsule = yield* Capsule.make({ root, runtime, checkoutRoot, credentials })
  const driver = yield* CapsuleWorkspace.make().pipe(
    Effect.provideService(Capsule.Capsule, capsule),
  )
  return { capsule, driver }
})
```

An embedding host passes the resulting driver as an SDK workspace provider, for
example `OpenCode.create({ workspaceProviders: { capsule: driver } })`.

The workspace ID is the Capsule ID. The provider's `create` attaches only an
already-ready Capsule; the caller explicitly runs `capsule.create` or
`capsule.prepare` first. `connect` checks the persisted binding and returns a
sandboxed spawner, `destroy` purges, and idle suspension does nothing. There is no
in-memory source-spec resolver or implicit preparation fallback. OpenCode's environment overrides, such as
`TERM`, extend the development shell environment. Provider errors expose only
Capsule's own messages.

For managed workspaces, call the SDK's `workspace.provision` before creating a
session, then use the returned binding's checkout directory as the session's
location. OpenCode's host-side project discovery needs that directory to exist.

The hosted build in `lib/capsule` keeps `effect` and `@opencode/sdk` as peers so
the host's instances are shared. The standalone CLI bundles Effect and never loads
the SDK.

The SDK integration tests drive two workspaces through one embedded OpenCode
host, covering controlled, borrowed and managed modes. Real Capsule modes are
enabled by `CAPSULE_TEST_RUNTIME` in the Linux development shell. They exercise Nix
development environments, native read/shell/grep/glob tools, and refusal to follow
a checkout symlink to a host-only file. The fixture uses pinned Bun to host the
SDK; the standalone Capsule CLI runs on pinned Node 22.

OpenCode resolves its shell and ripgrep executable on the host before passing
them to the provider. The embedding host must select `/bin/sh` or a shell under
`/nix/store`, and put the runtime's `basePath` first on its own `PATH` so ripgrep
resolves to a store path. Host profile symlinks and OpenCode's downloaded ripgrep
cache are not visible inside Capsule. No broader host mounts are added to make
those paths work.

## Shared native OpenCode host

`programs.limitless.capsule.enable` registers the provider in the existing native
OpenCode server. Host settings supply runtime, checkout and control directories,
pinned tools, optional Docker access and credential sources. The generated
`capsule/host.json` contains non-secret settings and credential paths, never token
values. The configured executable passes its path through
`OPENCODE_CAPSULE_CONFIG` and selects a Capsule-visible shell and base tools.

A narrow native composition patch constructs one Capsule service in the host's
application scope, installs its workspace driver and contributes the typed
`@limitless/capsule/rpc` contract. The server keeps its native authentication,
database, sessions and lifecycle; it does not start another inference server.

`prepareSession` reserves the native workspace, creates its Capsule, provisions
the binding and creates a session with both the actual checkout directory and
workspace ID. Native session-ID adoption is checked explicitly against the
owner and placement. A retry uses the same source intent and IDs; it never
silently resumes an operator-stopped or purged Capsule.

`getSession` proves retained session ownership without preparing or recreating
anything. It reports the Capsule phase and whether the native workspace is bound,
unprovisioned or absent. Readiness requires both `ready` and `bound`, but retained
identity remains useful for interruption and history after stop or purge.

RPC registration exists only at the configured host control Location, outside
all checkout and runtime roots. Its address keeps the declared symlink path,
normalized in the same way as OpenCode Locations; its physical target is checked
for overlap with storage roots. Clients use that declared address and check the
read-only `info` capability while plugins activate. The returned storage
fingerprint pins the configured storage roots; it is not a globally unique machine identity. See the
[Pipeline guide](pipeline.md#worker-capsule-host) for host and coordinator setup.

The configuration applies to each native server started with the configured
executable. Use the normal shared service; isolated standalone tests need their
own host settings, storage roots and OpenCode database.

## Limitations

- Isolation is limited to spawned commands; see [Scope](#scope).
- Network ports, the Nix daemon and Docker resources are shared with the host and
  other Capsules. Configured GitHub tokens are visible to every command.
- Managed sources are GitHub-only, are never refreshed from the remote, and are not
  archived or deleted by the CLI.
- The specification is immutable: changing `capsule.json`, the Docker socket or
  the source request requires a new ID.
- Previews and persistent per-Capsule helpers are out of scope.
