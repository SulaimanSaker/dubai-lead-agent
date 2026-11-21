# evals — rules for the evaluation suite

Evals measure the agent with real model calls. They are NOT unit tests and they cost money (Claude) or time (local).

## The golden rule

**Never change files in `evals/cases/` to make a failing eval pass.** A failing eval means the agent is wrong, not the case.
If you believe a case itself is wrong, stop and explain why to the human. A hook asks the human before any edit there.

## Adding a case

Use the `add-eval-case` skill. Cases live in one JSON file per category in `evals/cases/` (validated by
`evals/lib/cases.ts`), each with the buyer messages and the expected end state (lead fields, tool calls, booking and
handoff yes/no, language). One behaviour per case, named after it (e.g. `cash-buyer-marina-2bed`). Every case states
both `viewingBooked` and `handoff`, so doing nothing can't pass.

## Checks

- Code checks (cheap, exact) come first: extraction, tool use, booking, handoff, no invented prices, turns, language, style.
- LLM-as-judge (Claude Sonnet 5.5, not the agent's own model) for `answers`, `grounded`, `professional`. It sees the
  replies the buyer saw plus what the agent was told (prompt, tool descriptions, turn context).
- Headline `pass` = all code checks AND judge `answers` + `grounded`; `code_pass` is the code-only result.
- Changing the judge? Bump `JUDGE_VERSION`, re-grade with `npm run evals:rejudge` (no agent re-run), then re-score
  calibration with `npm run evals:calibrate -- score <model>`.
- Run the null agent (`--provider null`) after any grading change: it must stay near 0%.
- Run folders follow the report layout: `evals/runs/<model>/baseline`, then `v1`, `v2`, … for each change, each with a
  `change.md` (first line = what changed). For Haiku: `baseline` = prompt v1, `v1` = prompt v2, `v2` = prompt v2 +
  Arabic amounts in the guard (3 Arabic cases), `v3` = prompt v3. A new prompt version: `--prompt v4 --variant v4`. Each row saves `prompt_version`; a folder never mixes versions (the runner refuses).
- Report real numbers only. Never estimate or invent a score.
