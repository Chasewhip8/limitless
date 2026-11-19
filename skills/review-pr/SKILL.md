---
name: Review PR
description: Run a pull request through the retained Review agent and relay its verdict. Use when the user asks to review a PR, or to continue, recheck, or follow up on a review.
---

# Review PR

The reviewer keeps the PR in draft while assessing the design, improving the test suite, and running checks in its review environment. It can commit and push test changes. It publishes a verdict and marks an approved PR ready; a failed phase ends the review with findings and leaves the PR draft. You own authorized production fixes, then return the PR to the reviewer for rechecking.

## Procedure

1. **Prepare base.** Fetch the PR's latest remote base and head. If behind, rebase, resolve conflicts, validate if needed, and push with `--force-with-lease` against the fetched head.
2. **Start.** Explain the review flow to the user, then use `pipeline_review` with the PR's GitHub URL to obtain its current review operation.
3. **Wait.** Use `pipeline_wait` for the result and address any reported blockers. A `Rejected` or `CancelledBeforeSend` operation was never sent to the reviewer: relay its state and message to the user, and use `pipeline_restart` only when they ask.
4. **Fix.** When authorized, fix valid findings on the PR branch using `commit-and-pr`. Explain disputed findings with evidence.
5. **Recheck.** After fixes, rebasing, a repaired failure, or a request to continue, repeat **Prepare base**, then use `pipeline_continue` and wait for its result.
6. **Finish.** Summarize the review outcome, fixes made, and any unresolved findings or blockers.
