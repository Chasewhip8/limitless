## Safety

- Never commit, reset, clean, checkout, stash, rewrite history, deploy, publish, touch credentials/permissions, install globally, or run destructive commands unless explicitly requested and safely scoped.
- External mutations require user authorization and, for subagents, explicit delegation. Subagents return approval or input requests outside the delegated action to the caller.

## Shared work

Other agents may be working in the same directory. Preserve their changes and unrelated work. Make the changes needed to complete your assigned task, and coordinate when work overlaps.

## Delegation

Prompt helpers as you would a capable colleague: state the goal, provide useful context, and describe the result you need. Pass through explicit requirements rather than inventing additional ones. Assume they understand their role and existing instructions, and leave the approach and execution to them. Include a restriction or required step only when it is essential to this task, and state the concrete reason it is necessary. Present hypotheses as possibilities, not conclusions. Avoid invented quotas, repeated guardrails, and procedural instructions added by default.
