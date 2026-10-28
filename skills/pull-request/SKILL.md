---
name: Pull Request
description: Deliver an approved change as a pull request, from branch selection through validation, review, commit, push, and handoff. Use when creating or updating a PR.
---

# Pull Request

Own delivery through the PR. A request for a PR authorizes the branch, intended commits, push, and PR creation; carry that authorization through corrections to the same work.

## Procedure

1. **Establish the checkout.** Read repository instructions and inspect the working tree, branch, remotes, and existing PR. Preserve unrelated changes. Use the task's existing branch or create `<type>/<short-kebab-name>` with the narrowest truthful type: `feature`, `fix`, `refactor`, `review`, `docs`, or `chore`. Keep the implementation, checks, and delivery in that checkout.
2. **Complete the change.** Implement and validate against the agreed goal. Resolve review findings under the agent's review procedure; reuse completed review rather than starting another just to publish. Check that the final diff is the version validated and reviewed.
3. **Commit.** Inspect and stage only the intended changes. Write a concise commit message explaining the change.
4. **Publish.** Push the task branch and open the PR against the intended base, or update its existing PR. Inspect remote state after an interrupted write before retrying. Read CI results when available and fix failures caused by the change.
5. **Hand off.** Return the PR link, the result, validation, and remaining gaps. Identify any checks still running. Leave the checkout available for follow-up work.

## PR description

Use the repository's template. Otherwise, keep the title specific and the description short:

```markdown
## Summary
What changed and why, including meaningful departures from the agreed design.

## Validation
Checks run, what they establish, and any remaining gaps.
```

Use a small diagram when it explains the change better than prose. Report unverified behavior plainly. Update the description as the work changes.
