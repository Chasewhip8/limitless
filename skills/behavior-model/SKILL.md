---
name: Behavior Model
description: Build evidence-backed behavioral models for design and analysis. Use to probe a provider or local system, or to map explicit and implicit state machines in code. Also use to compare a model with the current system.
---

# Behavior Model

Produce a model another engineer can reason from and revisit as the system changes.

## Start

Read the [model format](references/format.md) and establish what decision the model must support. Set the boundary for the investigation. Read any previous model and its evidence, preserving the baseline against which changes will be compared. On a later pass, begin with what has changed since that baseline.

Use the procedures the question needs, returning to them as evidence changes. They contribute to the same model. Follow the format's execution-safety rules before running anything, and use [Finish](#finish) once for the investigation.

## Probe a system

1. **Choose the question.** Start with what the system promises. Find the uncertainty whose answer most affects the design, then decide what observation would distinguish the competing explanations. A documented promise may still need checking before the integration relies on it.
2. **Prepare the target.** Establish a starting condition you can reproduce. Determine what the experiment could affect and agree its authorized scope. Resolve access before proceeding.
3. **Make the experiment runnable.** Reuse an existing way to drive the system where possible. Perform an action from the starting condition and verify that you can observe its result. Write this sequence so another engineer can repeat it, then try those instructions from the beginning.
4. **Test the explanation.** Run the experiment and follow the action through to its effects. Control the conditions that could account for a different outcome. Use the first result to shape the next experiment rather than designing the entire investigation in advance.
5. **Update the model.** Compare what happened with what was expected. Record the result under the format's evidence rules and revise the affected claims. Keep counterexamples. Continue with the next unresolved question while it remains within the approved scope; otherwise record what is needed to proceed.
6. **Leave it reproducible.** Save the evidence and rerun instructions beside the model, or link their existing location. Complete the agreed cleanup and record anything left in place before moving on.

## Map an implementation

1. **Locate the implementation.** Read the repository's instructions and establish which code you are examining. Check whether a running instance matches it. For an integration, include the external behavior its callers depend on.
2. **Follow the lifecycle.** Trace an entity from its creation until its work ends. At each point, ask what determines what can happen next. Follow every in-scope writer, including paths outside the normal flow. State may emerge from several values rather than a declared status.
3. **Name the transitions.** Express the conditions that distinguish one state from another. Trace what can change those conditions and where that change is enforced, linking back to the code. Separate machines that evolve independently and explain how they affect each other.
4. **Challenge the interpretation.** Follow what happens when work overlaps or stops partway through. Determine what survives and who can resume it. Use existing tests to check your reading; [probe the system](#probe-a-system) when a new experiment is needed.
5. **Assess the code's expression.** Say where the machine is explicit and where the reader must reconstruct it. If that obscures ownership or permits a harmful transition, explain the consequence and what a clearer representation would improve. Keep such proposals separate from the current model; findings do not authorize refactoring.

## Build or compare the model

1. **Explain the lifecycle.** Define what a state means and how the system moves between states. Keep independently evolving lifecycles distinct. Choose a representation that preserves the behavior without forcing every rule into a state machine.
2. **Establish what is known.** For each behavior the design relies on, ask how it is known. [Map the implementation](#map-an-implementation) to resolve questions about the code and [probe the system](#probe-a-system) when observation is needed. Improve the model as evidence arrives.
3. **Resolve disagreements.** Trace a disagreement back to its conditions before changing the model. Correct a mistaken interpretation, but retain a real violation as a finding. A proposed remedy does not replace the behavior of the current system.
4. **Challenge the explanation.** Walk a real journey through the model and look for where its prediction could fail. If formal analysis would answer a consequential question, use it at an explicit scope. Check that its counterexamples can occur in the real system before reporting implementation bugs.
5. **Compare with the baseline.** When an earlier model exists, match behavior by meaning and explain the differences. Distinguish a change in the system from a change in your understanding. Keep one authoritative account of each behavior.

## Finish

Apply the format's checks, accounting for paths you could not examine and dependencies that remain unresolved. Advance the baseline only for the scope rechecked; older evidence keeps its original conditions. Hand off the model with its consequential findings and the next actions needed to rely on it.
