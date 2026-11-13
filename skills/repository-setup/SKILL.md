---
name: Repository Setup
description: Make a repository reproducible from a fresh checkout and safe to run beside other checkouts. Use when setting up or auditing a repository for parallel agent work.
---

# Repository Setup

Make a fresh checkout ready for work using the repository's documented commands and host prerequisites, without hand-copied files or a manually filled `.env`. Checkouts should set up, run, test, and tear down independently on the same machine, including when they share a Docker daemon. Stopping preserves data; teardown removes the checkout's resources.

## Procedure

1. **Understand the setup.** Read the repository's instructions, environment, and lifecycle commands. Identify supported hosts, manual steps, and resources shared between checkouts.
2. **Try a fresh checkout.** Follow the documented setup and checks in a fresh worktree. Identify missing dependencies, files, secrets, and assumptions that prevent independent operation. For an audit, report the findings and proposed fixes without implementing them.
3. **Make setup reproducible.** Fix the gaps using committed configuration and commands. Document setup, run, check, stop, teardown, and host prerequisites in `AGENTS.md`. Connect the worktree runners the project uses, such as OpenCode, T3 Code, or Capsule, to those same commands; keep them usable from a standalone checkout.
4. **Verify side by side.** Set up two fresh checkouts of the resulting revision and run their checks concurrently. Tear one down and confirm the other still works and retains its data. Clean up the verification resources and check for leftovers.
5. **Report.** Summarize the changes, remaining host prerequisites, and what verification established.

## Constraints

- Respect runner-provided resource identities; otherwise scope mutable resources to the checkout, including locally built image tags. Allocate ports dynamically.
- Keep runtime state in ignored checkout paths, runner-provided state directories, or checkout-owned resources. Teardown removes only owned resources, never shared caches or unrelated workloads.
- Docker bind sources must be visible to the daemon, not just the calling process. Separate checkouts on shared daemons prevent collisions; they are not a security boundary.
