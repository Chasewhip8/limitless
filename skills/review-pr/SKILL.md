---
name: Review PR
description: Run a pull request through the retained Review agent and relay its verdict. Use when the user asks to review a PR, or to continue, recheck, or follow up on a review.
---

# Review PR

The reviewer keeps the PR in draft while assessing the design, improving the test suite, and running checks in its review environment. It can commit and push test changes. It publishes a verdict and marks an approved PR ready; a failed phase ends the review with findings and leaves the PR draft. You own authorized production fixes, then return the PR to the reviewer for rechecking.

## Procedure

1. **Start.** Explain the review flow to the user, then use `pipeline_review` with the PR's GitHub URL to obtain its current review operation.
2. **Wait.** Use `pipeline_wait` for the result and address any reported blockers.
3. **Fix.** When authorized, fix valid findings on the PR branch using `commit-and-pr`. Explain disputed findings with evidence.
4. **Recheck.** After fixes, a repaired failure, or a request to continue the review, use `pipeline_continue` and wait for its result.
5. **Finish.** Summarize the review outcome, fixes made, and any unresolved findings or blockers.
