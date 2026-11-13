---
name: Review PR
description: Run a pull request through the retained Review agent and relay its verdict. Use when the user asks to review a PR, or to continue, recheck, or follow up on a review.
---

# Review PR

The reviewer assesses the design, improves the test suite, runs verification and CI, and publishes a verdict on the PR. It can commit and push test changes; a failed phase ends the review with findings. You own authorized production fixes, then return the PR to the reviewer for rechecking.

## Procedure

1. **Start.** Explain the review flow to the user, then use `pipeline_review` with the PR's GitHub URL to obtain its current review operation.
2. **Wait.** Use `pipeline_wait` for the result and address any reported blockers.
3. **Fix.** When authorized, fix valid findings on the PR branch using `commit-and-pr`. Explain disputed findings with evidence.
4. **Recheck.** After fixes, a repaired failure, or a request to continue the review, use `pipeline_continue` and wait for its result.
5. **Finish.** Summarize the review outcome, fixes made, and any unresolved findings or blockers.
