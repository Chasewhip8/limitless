# Behavior model format

Use the requested location or the project's existing convention; otherwise start at `docs/behavior/<model>/model.md`. Keep a small model in one file and link supporting work as it grows. Procedures contributing to the same investigation share that model and its checks.

The main headings are **Scope**, **Model**, **Evidence**, and **Checks**. Add **Changes** when comparing with a baseline. Choose the notation that explains the system clearly; omit empty subsections.

## Scope

State the question and where the investigation stops. Identify the code revision, accounting for local changes; use a snapshot or content digest when no revision exists. For an external system, identify the version and configuration examined. Date observations and cited documentation so a later reader can establish what was current. Record common conditions once.

Make clear which behavior is implemented and which is known only through external observation. Label proposals separately. A policy requirement needs an authority; existing behavior does not establish what the policy should be.

## Model

Define what identifies an entity and when its lifetime ends. Explain what distinguishes its states and how its lifecycle affects other machines. Keep the actual state distinct from what an observer knows about it. State required properties without concealing their violations.

For each transition, identify its machine and starting state. Follow the trigger through the condition that permits the change to its possible outcomes. Show who performs it and what effects it has. Mark where work commits and how completion can be observed; steps that can interleave must not appear atomic. Link the definition to its evidence, including unresolved claims. An omitted transition is not implicitly forbidden.

Keep one authoritative definition of the transitions. When a diagram summarizes it, disclose meaningful omissions and resolve disagreements between views. Explain findings separately from the current behavior and distinguish proposed remedies from implemented changes.

## Evidence

Cite code-visible behavior directly in the model. When a property needs separate justification, give it a claim record. The following fields work as a table or labeled prose:

| Field | Meaning |
| --- | --- |
| Statement | What is claimed, under which conditions. |
| Basis | Where the claim comes from and what that source establishes. Link the source and identify any inference or assumption. |
| Status | `supported`, `contradicted`, or `open` within the stated scope. Preserve conflicting evidence. |
| Relied on by | What depends on this being true. |
| Next | How an open question will be resolved, or how an unsafe reliance will be addressed. |

Give a record a stable ID when something else refers to it. Keep its status in one place. If the model's concepts change, explain their correspondence rather than reusing an ID for a different meaning.

For a completed experiment, record enough to repeat it from the same conditions. Preserve the exact actions and dated results, then explain what they establish. Identify where simulation replaced the real system; a fake provider cannot establish real provider behavior. Save rerun instructions with any resources left in place or cleanup still owed. Planned experiments remain next actions, not evidence.

When behavior can vary, record the runs and orderings exercised. Samples alone cannot establish “always” or “never”. Give such a guarantee a contractual or deductive basis and state the assumptions limiting it; otherwise it stays open. Before concluding that an event was absent, show that the observer can detect that event and state an adequate observation window. A lost response does not establish that a write failed.

Record an owner's acceptance of risk as a decision, not evidence that the claim is true. A proposed redesign removes no dependency from the current implementation.

## Checks

Record each check as **applied** with its findings, **not applicable** with a reason, or **not done** with a blocker. Say which part of the scope was covered when the result is partial.

| Check | Question |
| --- | --- |
| Coverage | Can each scoped dependency and state writer be traced to the model or an explicit gap? |
| Transitions | Does the model explain the important journeys, including those that fail or get stuck? |
| Boundaries | Can ownership and recovery be followed across asynchronous or durable boundaries when work repeats or overlaps? |
| Evidence | Does the evidence justify each claim at its stated scope? |
| Comparison | Do differences reflect changed behavior or changed knowledge about it? |

Every unresolved reliance needs a next action or explicit blocker. Finishing the investigation does not establish that the system is safe.

## Changes

Start from the named baseline and match behavior by meaning. Explain any change in decomposition before comparing the transitions. Establish whether a difference comes from the system changing or from a better understanding of it, accounting for changed conditions or scope. Identify what was not rechecked. Keep this a comparison rather than an activity log.

## Execution safety

Inspect what an execution can affect before running it, even when it is an existing test. Follow connections out of the test environment to find shared settings or production destinations. Establish authorization for external or shared effects, accounting for irreversible actions and costs. A sandbox label does not establish isolation. Use approved credential mechanisms. Keep secrets and personal data out of the model and captured output.

Agree how resources will be handled before creating them. Check repository discovery rules when adding a harness; keep it out of default test, lint, and CI discovery until inclusion is requested.

Finish the agreed cleanup and verify the result. Record anything left in place with the rerun instructions, preserving the evidence. Do not change the system merely to make the investigation pass.
