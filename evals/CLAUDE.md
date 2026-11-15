# evals — rules for the evaluation suite

Evals measure the agent with real model calls. They are NOT unit tests and they cost money (Claude) or time (local).

## The golden rule

**Never change files in `evals/cases/` to make a failing eval pass.** A failing eval means the agent is wrong, not the case.
If you believe a case itself is wrong, stop and explain why to the human. A hook asks the human before any edit there.

## Adding a case

Use the `add-eval-case` skill. Each case is a JSON file in `evals/cases/` with the buyer messages and the expected outcome
(lead fields, tool calls, handoff yes/no). One behaviour per case, named after it (e.g. `cash-buyer-marina-2bed.json`).

## Checks

- Code checks (cheap, exact) come first: extraction, tool use, no invented prices, handoff.
- LLM-as-judge (Claude Haiku 5.5) only for soft qualities like tone and language.
- Report real numbers only. Never estimate or invent a score.
