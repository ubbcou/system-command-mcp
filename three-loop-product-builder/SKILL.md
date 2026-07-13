---
name: three-loop-product-builder
description: "Use when building or iterating a 0-to-1 product, MVP, prototype, feature, or user-facing workflow with Andrew Ng's three feedback loops: agentic coding loop, developer feedback loop, and external user feedback loop. Trigger for product iteration, agentic coding workflows, MVP planning, converting user feedback into implementation tasks, deciding the next smallest product bet, or balancing AI coding speed with human/product judgment."
---

# Three-Loop Product Builder

Use three nested loops to turn product intent into shipped learning. Keep the coding loop fast, but do not let coding speed substitute for product evidence.

## Core Model

1. Agentic Coding Loop
   - Cadence: minutes.
   - Actor: coding agent.
   - Goal: implement one small testable change.
   - Output: diff, test result, screenshot/log, or working artifact.

2. Developer Feedback Loop
   - Cadence: tens of minutes to hours.
   - Actor: human developer/product owner plus agent.
   - Goal: use human context advantage to decide whether the result is right.
   - Output: keep, revise, revert, narrow, ship, or gather more evidence.

3. External Feedback Loop
   - Cadence: hours, days, or weeks.
   - Actor: real users, customers, stakeholders, analytics, sales/support.
   - Goal: learn whether the product direction matters outside the builder's head.
   - Output: validated learning, changed priority, new hypothesis, or stop signal.

## Pick The Active Loop

- If the user asks to build or fix something concrete, run the Agentic Coding Loop.
- If the user asks "is this good?", "what next?", "does this solve it?", or gives subjective feedback, run the Developer Feedback Loop.
- If the user provides customer/user/market feedback, run the External Feedback Loop.
- If unclear, default to the Developer Feedback Loop and clarify the next smallest product bet.

## Workflow

1. State the current product hypothesis in one sentence.
2. Identify the target user and expected behavior change.
3. Pick the smallest change that can test or advance the hypothesis.
4. Implement only that change when implementation is requested.
5. Verify with the cheapest meaningful check: test, build, screenshot, manual flow, or log.
6. Summarize evidence, not just activity.
7. Incorporate developer feedback.
8. For user-facing work, define how external feedback will be collected.
9. Update the next product bet.

## Agentic Coding Loop

When implementing:

- Keep the diff small.
- Reuse existing code patterns.
- Prefer working product behavior over speculative architecture.
- Add tests only where they protect the behavior being changed.
- Do not invent analytics, user feedback, or product validation.
- Stop after one coherent increment.

Output:

```text
Loop: Agentic Coding
Hypothesis:
Change:
Verification:
Evidence:
Next developer decision:
```

## Developer Feedback Loop

When reviewing or deciding direction:

- Treat the human's context as first-class input.
- Ask what they know that the codebase cannot show: customer urgency, market timing, brand promise, support pain, sales objections, internal constraints.
- Convert vague feedback into one concrete next change.
- Prefer narrowing scope over expanding the build.

Output:

```text
Loop: Developer Feedback
Human signal:
Decision:
Next smallest change:
Risk:
What would change our mind:
```

## External Feedback Loop

When processing real-world feedback:

- Separate signal from anecdote.
- Capture source, user type, frequency, severity, and business impact.
- Translate feedback into a product hypothesis before coding.
- Avoid building every requested feature.
- Prioritize repeated pain, blocked workflows, willingness to pay, or retention impact.

Output:

```text
Loop: External Feedback
Source:
Observed pain:
Product hypothesis:
Evidence strength:
Next experiment:
Coding task, if any:
```

## Guardrails

- Do not let the coding loop outrun the feedback loops.
- Do not call something validated until real users or credible external evidence support it.
- Do not turn one comment into a roadmap.
- Do not build infrastructure for a hypothesis that has not survived developer review.
- Escalate when the next decision depends on pricing, positioning, legal, security, or customer commitments.

## Minimal State

Maintain a small state file when the task spans multiple sessions:

```markdown
# Product Loop State

## Current Hypothesis

## Target User

## Last Agentic Coding Result

## Developer Feedback

## External Feedback

## Next Smallest Bet

## Stop / Pivot Signals
```

## Done Criteria

An iteration is done when it produces one of:

- A verified product change.
- A clear human decision.
- A documented external signal.
- A stop, revert, or pivot decision.
