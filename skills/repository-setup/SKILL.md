---
name: Repository Setup
description: Make a repository ready for parallel agent work, so any commit checked out into a fresh worktree sets itself up and runs beside other checkouts on the same machine. Use when setting up or auditing a repository for units or worktrees.
---

# Repository Setup

A ready repository meets four invariants:

1. **Bootstraps from a commit.** A fresh checkout of any commit reaches a working setup by following its `AGENTS.md`, with no files copied in by hand.
2. **Holds its secrets.** Secrets are committed encrypted and decrypted with a key the host already has, or fetched by a committed script. A checkout never needs a hand-filled `.env`.
3. **Runs beside itself.** Two checkouts on one machine can set up, run, test, and tear down at the same time without colliding.
4. **Keeps its state.** Runtime state lives in ignored paths inside the checkout or in resources named for it, and teardown removes all of it.

## Procedure

1. **Read the repository's setup.** Read its `AGENTS.md`, README, environment definition (such as a Nix flake or tool-version files), container and compose files, scripts, and `.gitignore`. Note every step a person performs by hand.
2. **Bootstrap a fresh checkout.** Add a worktree of `HEAD` in a temporary directory and follow `AGENTS.md` exactly, through setup and the required checks. Record each missing step, untracked file, and failure.
3. **Find shared names.** While that checkout runs, list everything it claims on the machine: container, compose project, network, and volume names; ports; database names; paths outside the checkout; and caches that are not safe to use concurrently. Then tear it down and remove the worktree.
4. **Fix each finding.**
   - Declare tools and dependencies in the repository, pinned by lockfiles.
   - Replace hand-provisioned secrets with committed encrypted files or a committed fetch script. Ask the user before choosing a secrets mechanism or adding keys.
   - Derive per-checkout names from the checkout, for example a compose project name from a short hash of its path. Let ports default to dynamic allocation, or derive them, and record chosen values in ignored state inside the checkout.
   - Move state, logs, and local databases into ignored paths inside the checkout, and give teardown a command that removes its containers, volumes, and state.
   - Document setup, run, check, and teardown in `AGENTS.md`, plus any one-time host prerequisite such as a decryption key.
   - For native OpenCode Units, use the project's worktree startup command (`project.commands.start`) to invoke the committed setup command. This setting lives in OpenCode's per-host project database; document configuring it as a host prerequisite. Document teardown separately: removing a native worktree does not tear down application resources.
   - For worktrees created through Paseo's UI, commit a `paseo.json` whose `worktree.setup` and `worktree.teardown` run the documented commands; Paseo runs them when it creates and archives a worktree, from the base branch's committed file, with `$PASEO_SOURCE_CHECKOUT_PATH` naming the source checkout. Add the checks and long-running services agents start as `scripts`.
   - For T3 Code, commit a `t3.json` with a setup script (`runOnWorktreeCreate: true`, `async: false`) and a teardown script (`runOnSettle: true`) that run the documented commands. T3 runs only imported actions, so tell the user to import them once in Settings → Project → Actions.
5. **Verify side by side.** Add two fresh worktrees of the same commit, set both up, and run their checks at the same time. Tear both down, then confirm no containers, volumes, networks, listeners, or files outside the checkouts remain. Remove both worktrees.
6. **Report.** List the changes, the host prerequisites that remain, and the verification results with the commands that produced them. When asked only to audit, stop after step 3 and report the findings with proposed fixes.
