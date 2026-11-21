# 0007 — Evals: code checks first, a different model as judge, versioned grading

- **Status:** proposed
- **Date:** 2026-11-20

## Context

We need one number per model and prompt version that says "is the agent good?", so model choice (Claude Haiku
5.5 vs a local Gemma 3 4B) and prompt changes are decided by data. The agent is Claude Haiku 5.5. Most of
what matters can be checked exactly in the end state (saved lead fields, bookings, handoff, tool calls, prices),
but some of it can't ("did the reply answer the question?").

What we measured while building it:

- A do-nothing agent ("Hello! How can I help you today?") passed **29%** of cases on code checks alone. Every
  "should NOT book / hand off / invent" case is satisfied by doing nothing.
- The first judge called true facts invented ("AED 260,000 per year", "Sunday is closed") because it didn't see
  the agent's instructions, and graded text the buyer never sees (written next to tool calls).

## Decision

- **Code checks first** (`evals/lib/grade.ts`), on the end state in a fresh database per run, through the real
  `handleBuyerMessage`. Expectations come from the seed data, never from a model's output.
- **An LLM judge for what code can't see** (`answers`, `grounded`, `professional`), on **Claude Sonnet 5.5**: a
  different model from the agent, because a model grading its own replies tends to be too kind.
- **Headline `pass` = all code checks AND the judge's `answers` + `grounded`.** `code_pass` is also reported.
  With this, the do-nothing agent scores 0%.
- **The judge sees what the buyer saw plus what the agent was told** (system prompt, tool descriptions, turn
  context). Judge output is structured (JSON schema) and validated with Zod.
- **The judge is versioned** (`JUDGE_VERSION` on every row) and **calibrated** against human labels
  (`npm run evals:calibrate`). After a judge change, saved traces are re-graded without re-running the agent
  (`npm run evals:rejudge`), so before/after only differ in the grader.
- **Infra failures are never scored:** provider errors, timeouts, a different model than requested, and judge
  failures go to `errors.jsonl`; the (case, rep) is retried on the next run.
- **`src/agent/llm/structured.ts`** holds the judge's Claude call: only `src/agent/llm/` may use provider SDKs.
  It is Claude-only on purpose and not part of `LlmProvider` (the judge must not be swappable to the local model).

## Alternatives considered

- **Judge only (no code checks):** slower, costs more, and less repeatable; it also can't see the database.
- **Code checks only:** passed a do-nothing agent on 29% of cases.
- **Haiku 5.5 as judge:** cheaper, but it is the agent's own model.
- **Re-run the agents after each judge change:** costs more and adds model randomness, so a before/after mixes
  two changes.

## Consequences

- A full Claude run (31 cases × 3 reps) costs about $0.50, mostly the judge: the agent is about $0.0005 per case,
  the judge 4–7× that. Evals run on demand, not on every commit.
- The judge has some noise (about 2 rows in 93 flipped between gradings), so the headline uses 3 reps and reports
  a 95% interval.
- A judge change means: bump `JUDGE_VERSION`, re-grade, re-score calibration, re-run the null agent.
- Rows are resumed by (case, rep) only; when prompt v2 arrives, results go to a new variant directory so old rows
  aren't reused.

## Addendum (2026-11-21, prompt v2)

- **One prompt version per run folder**, enforced: every row saves `prompt_version`, and the runner refuses to add
  rows of another version (and any turn that used another version). Folders follow the report builder's layout:
  `baseline`, then `v1`, `v2`, … with a `change.md` (`evals/lib/variants.ts` picks the default).
- **A prompt version is more than the system prompt:** `PromptVersion` now also holds the price-guard
  correction note (`priceCorrection`), because it is an instruction to the model. Released versions are locked by
  tests (hashes of v1's and v2's text, snapshots of v1's dynamic part and note).
- **Prompt examples must not copy an eval case.** v2's example matched `buyer-states-a-wrong-price`, which
  inflates that case; new rules are checked on held-out cases.
- **Headline `pass` includes `language`** since 2026-11-21 (an English reply to an Arabic buyer is a failure);
  `style` stays separate.
- **The price grader and the guard share `findInventedPrices`.** A guard change is also a grader change: re-grade
  the saved rows (no model calls) so every version is graded the same way. Since 2026-11-21 it reads Arabic
  thousand / million words.
