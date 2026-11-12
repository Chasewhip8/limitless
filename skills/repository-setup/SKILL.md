---
name: Repository Setup
description: Make a repository ready for parallel agent work, so any commit checked out into a fresh worktree sets itself up and runs beside other checkouts on the same machine. Use when setting up or auditing a repository for worktrees.
---

# Repository Setup

A ready repository meets four invariants:

1. **Bootstraps from a commit.** A fresh checkout of any commit reaches a working setup by following its `AGENTS.md`, with no files copied in by hand.
2. **Holds its secrets.** Secrets are committed encrypted and decrypted with a key the host already has, or fetched by a committed script. A checkout never needs a hand-filled `.env`.
3. **Runs beside itself.** Two checkouts on one machine can set up, run, test, and tear down at the same time without colliding, including when they share one Docker daemon.
4. **Keeps its state.** Runtime state lives in ignored paths inside the checkout, in a state directory its runner provides, or in resources named for it. Stopping keeps that state; an explicit teardown removes all of it.

Separate checkouts on a shared Docker or Nix daemon are hygiene for trusted code, not a security boundary. Docker socket access grants the daemon's authority (root for rootful Docker, its owning user for rootless Docker), and checkouts share the daemons, network, and host ports.

## Procedure

1. **Read the repository's setup.** Read its `AGENTS.md`, README, environment definition (such as a Nix flake or tool-version files), container and compose files, scripts, and `.gitignore`. Note every step a person performs by hand.
2. **Bootstrap a fresh checkout.** Add a worktree of `HEAD` in a temporary directory and follow `AGENTS.md` exactly, through setup and the required checks. Record each missing step, untracked file, and failure.
3. **Find shared names.** While that checkout runs, list everything it claims on the machine: container, compose project, network, volume, and locally built image names; ports; bind-mount sources; database names; paths outside the checkout; and caches that are not safe to use concurrently. Then tear it down and remove the worktree.
4. **Fix each finding.**
   - Declare tools and dependencies in the repository, pinned by lockfiles. When the environment is a Nix flake, provide it for every intended host system, such as `x86_64-linux` and `aarch64-linux`, or document the systems it deliberately excludes.
   - Replace hand-provisioned secrets with committed encrypted files or a committed fetch script. Ask the user before choosing a secrets mechanism or adding keys.
   - Derive per-checkout names from the checkout, for example a compose project name from a short hash of its path. Allocate ports dynamically, record chosen values in ignored state inside the checkout, and pass them to each tool through its native configuration, such as environment variables, flags, or config files. Do not derive ports from hashes, which can collide.
   - Move state, logs, and local databases into ignored paths inside the checkout. Give it a stop command that keeps data and a separate teardown command that removes its containers, volumes, and state.
   - Make Docker usage safe on a shared daemon, as described in [Shared Docker](#shared-docker).
   - Document setup, run, check, stop, and teardown in `AGENTS.md`, plus any one-time host prerequisite such as a decryption key.
   - For native OpenCode worktrees, use the project's worktree startup command (`project.commands.start`) to invoke the committed setup command. This setting lives in OpenCode's per-host project database; document configuring it as a host prerequisite. Document teardown separately: removing a native worktree does not tear down application resources.
   - For T3 Code, commit a `t3.json` with a setup script (`runOnWorktreeCreate: true`, `async: false`) and a teardown script (`runOnSettle: true`) that run the documented commands. T3 runs only imported actions, so tell the user to import them once in Settings → Project → Actions.
   - When the repository is also meant to run under Limitless Capsule, commit a `capsule.json` whose `setup`, `stop`, and `purge` argument vectors run the documented commands. Capsule is optional; the documented commands must keep working in a standalone checkout.
5. **Verify side by side.** Add two fresh worktrees of the same commit, set both up, and run their checks at the same time. While both run, tear one down completely and confirm the other still runs and keeps its data. Then tear the other down and confirm no task-owned containers, volumes, networks, image tags, listeners, or files outside the checkouts remain. Shared image layers and build caches may remain. Remove both worktrees.
6. **Report.** List the changes, the host prerequisites that remain, and the verification results with the commands that produced them. When asked only to audit, stop after step 3 and report the findings with proposed fixes.

## Shared Docker

Assume other checkouts of the same repository use the same daemon at the same time.

- **Project identity.** Use the task-specific Compose project name the runner provides; Capsule sets `COMPOSE_PROJECT_NAME`. Otherwise derive one per checkout. Do not commit a fixed top-level `name:` that would apply when no project name is set.
- **Resource names.** Do not set `container_name`, fixed network or volume `name:` values, or `external: true` writable volumes or networks, unless the name includes the task's project name. Let Compose prefix resources with the project name.
- **Ports.** Publish container ports without fixed host ports, for example `127.0.0.1::5432`, and read the assignment with `docker compose port`. Pass discovered ports to applications through their native configuration.
- **Bind mounts.** The daemon resolves bind sources on its own host, not in the caller's mount namespace. Use real absolute paths that the daemon sees identically, such as paths inside the checkout. Never use a private `/tmp` as a bind source: under Capsule, `/tmp` is a per-task mount the daemon cannot see, and with OrbStack or another VM-backed daemon only shared host paths resolve.
- **Images.** Share pulled image layers; pin digests when immutable inputs are required, since tags can move. When checkouts build images independently, give locally built images task-specific names, such as Compose's default `<project>-<service>`, instead of a shared mutable tag.
- **Stop and teardown.** Stop keeps data, for example `docker compose stop` or `down` without `--volumes` when all required data lives in named volumes or bind mounts. Teardown removes only the project's own resources, for example `docker compose down --volumes --remove-orphans --rmi local`, plus explicitly owned custom image tags if needed. Never use global cleanup, such as `docker system prune`, `docker volume prune`, removing all containers, or resetting the daemon, for project teardown.
