# Capsule guide

Capsule runs commands for a retained source checkout inside its Nix development
environment, through Bubblewrap. It is a small Effect library and CLI, independent
of Pipeline. It keeps per-task state between commands so work can stop and resume,
and it can expose an existing host Docker daemon to the checkout's commands.

Capsule is development hygiene for **trusted** code, not a security boundary.
Commands share the host network, the Nix daemon and any exposed Docker daemon.
Docker socket access grants the authority of that daemon: typically root for a
rootful daemon, or its owning user for a rootless daemon. Isolation covers only
the operations routed through Capsule; see [Scope](#scope).

## Status

| Area | State |
| --- | --- |
| Core service and `capsule` CLI | Implemented for `x86_64-linux` and `aarch64-linux` |
| OpenCode workspace provider (`@limitless/capsule/opencode`) | Implemented against the published `@opencode/sdk` `2.2.7` Effect SDK |
| Native OpenCode host registration | **Not implemented**; no Home Manager option or service configuration loads the provider |
| Pipeline integration | **Not wired**; Pipeline still prepares its own checkouts |
| Preview environments | Deferred |

## Ownership

| Owner | Responsibility |
| --- | --- |
| Capsule | Identity, lifecycle phases, private home and temporary directories, the Bubblewrap command boundary, and the lifecycle lock |
| Repository | Its flake development shell and optional `capsule.json` hooks that start, stop and purge its services |
| Caller | The source checkout, a unique Capsule ID per task, the state root, and the decision to stop or purge |
| Docker daemon | Containers, volumes, networks and images, scoped only by the repository's own naming |

Capsule never creates, moves or deletes the source checkout and never starts a
Docker daemon.

## Scope

Each command gets new mount and PID namespaces. Inside, it sees:

- the checkout, read-write, at its real path;
- private `HOME`, XDG configuration/cache/state, `TMPDIR` and runtime directories,
  with the private temporary directory also mounted at `/tmp`;
- `/nix/store`, the Nix daemon socket and database, and selected `/etc` network
  and Nix files, read-only;
- the Docker socket given to `prepare`, if any.

For ordinary linked Git worktrees and separate gitdirs, Capsule also exposes the
gitdir and common Git metadata directory read-write at their existing paths.
Those are borrowed resources: purge never removes or unregisters them. Worktrees
continue to share Git objects, references and configuration; Capsule does not
isolate Git operations from the other worktrees of that repository. External
object alternates and unusual symlinked Git layouts are not covered by this MVP.

The host process environment is never inherited. Host home directories, SSH
agents and credential files outside these mounts are not visible.

Capsule does not isolate the network, CPU or memory, the Nix daemon, or Docker.
In an OpenCode workspace, agent shell commands and the agent's file tools use the
provider; OpenCode implements file operations through sandboxed GNU commands.
Client-facing filesystem endpoints, formatters, PTY terminals and file watching
still use host paths. Native-host integration must address those separate paths
before promising a unified private filesystem view.

## Build and verify

```sh
nix build .#capsule
nix run .#checks.x86_64-linux.capsule
# On ARM Linux, use checks.aarch64-linux.capsule instead.
```

The package wraps the CLI with `CAPSULE_RUNTIME_CONFIG`, a pinned runtime JSON
(also installed at `share/capsule/runtime.json`) naming Bubblewrap, Bash, `env`,
Nix, `flock`, CA certificates and a base `PATH` of shell, Git, ripgrep, Nix and
Docker client tools. Language runtimes come from the project's development shell.

The flake check builds the package and validates its runtime without namespaces,
because build sandboxes cannot create user namespaces or reach the Nix daemon.
Run the check's `validate-capsule` runner on the host, as above, to exercise real
Bubblewrap, a fixture flake, lifecycle hooks, and purge tombstones.

## State root

Every invocation needs a dedicated absolute state directory, given by `--root` or
`CAPSULE_ROOT`. There is no default. The root must not contain, or be inside, a
prepared checkout. Capsule creates it with mode `0700` and stores:

```text
<root>/<id>/manifest.json    identity, specification, generation and phase
<root>/<id>/home             private HOME
<root>/<id>/home/.local/state/capsule   writable CAPSULE_STATE_DIR
<root>/<id>/tmp              private TMPDIR and /tmp
<root>/<id>/run              private XDG_RUNTIME_DIR
<root>/.locks/<id>           lifecycle lock
```

Capsule refuses to adopt a nonempty directory without a manifest, a manifest
belonging to another ID, or control paths containing symlinks.

## Repository contract

`prepare` evaluates `<checkout>#<devShell>` with `nix develop
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
idempotent because an interrupted phase reruns them. Follow the
[repository-setup skill](../skills/repository-setup/SKILL.md) for Compose, port and
teardown rules on a shared Docker daemon.

## CLI

Global flags precede the subcommand. Lifecycle commands print the manifest as
JSON, or `null` when the ID has no Capsule.

```sh
capsule --root "$STATE" prepare <checkout> --id <id> [--docker-socket <socket>] [--refresh]
capsule --root "$STATE" exec <id> [--cwd <dir>] -- <command> [args...]
capsule --root "$STATE" inspect <id>
capsule --root "$STATE" stop <id>
capsule --root "$STATE" purge <id>
```

IDs match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` and must be unique across tasks
sharing a Docker daemon, not merely within one state root. `prepare` takes an existing
directory and its current `capsule.json`. `--docker-socket` must name an existing
Unix socket. `exec` runs in the checkout by default, resolves a relative `--cwd`
against it, and exits with the command's status.

## Lifecycle

```text
prepare → preparing → ready ─stop→ stopping → stopped ─prepare→ preparing → ready
                        └── purge → purging → removing → purged (tombstone)
```

- **Prepare** writes `preparing`, creates the private directories, runs `setup`,
  then writes `ready`. Preparing a `ready` Capsule without `--refresh` returns the
  same manifest without running anything.
- **Refresh** (`--refresh`) starts a new generation, reloads the development
  environment, and reruns the same `setup` hook.
- **Resume**: preparing a `stopped` Capsule reruns `setup` with its retained
  private directories and repository data. A failed or interrupted `prepare` or
  `stop` remains in its intermediate phase; the next call reruns it.
- **Stop** runs the `stop` hook and keeps every directory. Stopping a stopped or
  purged Capsule returns its manifest.
- **Purge** runs `stop` and then `purge` when either hook exists, records
  `removing`, deletes the private home, temporary and runtime directories, and
  leaves a `purged` manifest. An interrupted deletion resumes without reloading
  the deleted environment or repeating completed service teardown. The source
  checkout remains. A purged ID cannot be prepared again.
- An ID is bound to an immutable specification: checkout, `capsule.json`
  contents and Docker socket. Preparing it with a different specification fails
  with `ownership_mismatch`, even with `--refresh`. Changing hooks or the shell
  name currently requires a new ID.

`prepare`, `stop` and `purge` take an exclusive lock; each command holds a shared
lock until its execution scope closes. The CLI and OpenCode close that scope
after execution. Nothing waits for the lock: a lifecycle operation
during an active command fails with `LockBusy`, and a command started during a
lifecycle operation is refused. Cancel running commands before stopping,
refreshing or purging.

Every spawn checks the phase under its shared lock. Commands are refused with
`not_prepared` unless the Capsule is `ready`, so after `stop` they fail until an
explicit `prepare`; nothing prepares automatically during execution. A command
whose lock holder dies is killed.

## Environment

A connection evaluates the development shell inside the sandbox, running its
`shellHook`, and captures the complete resulting environment. It caches that
environment by manifest generation: commands reuse it until the generation
changes, and the next command after `prepare --refresh` or `stop` and `prepare`
evaluates the shell again. Existing connections, including cached OpenCode
workspace connections, need no manual reconnect. Each `capsule exec` is a new
connection. Capsule keeps the environment only in memory, marked as redacted, and
never writes it to the manifest or state root. Keep `shellHook` fast and
idempotent.

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
entries.

On-disk changes in the checkout are visible immediately. Changes to the flake,
its inputs, or files the shell evaluates take effect after `prepare --refresh`,
or in a new connection.

## Processes and services

Capsule has no persistent helper. Every command, and each stage of a piped
command, is its own Bubblewrap process with its own PID namespace. When the
command exits, background descendants it started end with it. A foreground
long-running command, such as a development server, runs until it exits or its
caller cancels it.

Services that must outlive a command run in the shared Docker daemon. The
repository starts them from `setup` and stops or removes them from `stop` and
`purge`. Capsule does not track containers itself.

## OpenCode workspace provider

The core layer comes from the main package; the provider is a separate export
that requires the `Capsule` service:

```ts
import { Effect } from 'effect'
import * as Capsule from '@limitless/capsule'
import * as CapsuleWorkspace from '@limitless/capsule/opencode'

// resolveCheckout returns an Effect of { directory, project, dockerSocket? }.
const makeDriver = CapsuleWorkspace.make({ resolveSpec: resolveCheckout }).pipe(
  Effect.provide(Capsule.layer({ root, runtime })),
)
```

`Capsule.layer` needs `ChildProcessSpawner`, `FileSystem` and `Path`; `runtime` is
the package's runtime JSON decoded with `RuntimeSettings`. An embedding host
passes the resulting driver as an SDK workspace provider, for example
`OpenCode.create({ workspaceProviders: { capsule: driver } })`.

The workspace ID becomes the Capsule ID. `create` prepares, `connect` checks the
persisted binding and returns a sandboxed spawner, `destroy` purges, and idle
suspension does nothing. OpenCode's environment overrides, such as `TERM`, extend
the development shell environment. Provider errors expose only Capsule's own
messages.

The hosted build in `lib/capsule` keeps `effect` and `@opencode/sdk` as peers so
the host's instances are shared. The standalone CLI bundles Effect and never loads
the SDK.

The SDK integration test drives two concurrent workspaces through one embedded
OpenCode host. It has both a controlled contract test and a real Capsule mode
enabled by `CAPSULE_TEST_RUNTIME` in the Linux development shell. The real mode
exercises Nix development environments, native read/shell/grep/glob tools, and
refusal to follow a checkout symlink to a host-only file. The fixture uses pinned
Bun to host the SDK; the standalone Capsule CLI runs on pinned Node 22.

OpenCode resolves its shell and ripgrep executable on the host before passing
them to the provider. The embedding host must select `/bin/sh` or a shell under
`/nix/store`, and put the runtime's `basePath` first on its own `PATH` so ripgrep
resolves to a store path. Host profile symlinks and OpenCode's downloaded ripgrep
cache are not visible inside Capsule. No broader host mounts are added to make
those paths work.

## Limitations

- Native OpenCode host registration and Pipeline integration are not wired.
- Isolation is limited to spawned commands; see [Scope](#scope).
- Network ports, the Nix daemon and Docker resources are shared with the host and
  other Capsules.
- The specification is immutable: changing `capsule.json` or the Docker socket
  requires a new ID.
- Previews and persistent per-Capsule helpers are out of scope.
