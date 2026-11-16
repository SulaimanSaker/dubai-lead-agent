# 0002 — Model choice and a swappable model layer

- **Status:** accepted
- **Date:** 2026-11-15

## Context

The agent needs an LLM with reliable tool calling. Claude is the target model, but every call costs money.
A local model (Gemma 3 4B in LM Studio) is free and offline, but weaker.

A quick test (3 runs, temperature 0) with the message "2 bed in Dubai Marina, budget around 120k a year, paying cash":
Gemma 3 4B called `search_listings` with correct arguments every time, but never called `update_lead` —
so the buyer's budget and cash financing were lost.

## Decision

- Put all model access behind one interface, `LlmProvider`, in `src/agent/llm/`.
- Two adapters:
  - `claude.ts` — **Claude Haiku 5.5** (`claude-haiku-5-5`) through the official Anthropic SDK. Used for the
    demo and final evals. (Was Opus 5.5 until 2026-11-16, see the update below.)
  - `local.ts` — **Gemma 3 4B** through LM Studio's OpenAI-compatible API (`http://localhost:1234/v1`). Used for free development and as a comparison row in evals.
- Select with `LLM_PROVIDER=claude|local`.
- LLM judge in evals: **Claude Haiku 5.5** (`claude-haiku-5-5`) — cheap and good enough for scoring tone and language.
- ESLint blocks provider SDK imports outside `src/agent/llm/`.

## Alternatives considered

- **Claude only** — simplest, but every UI tweak costs API calls, and we lose the comparison story.
- **Local only** — free, but tool calling and rule-following are weaker (see the test above), and the role is about production LLM apps.
- **A framework that abstracts providers** — less code, but hides the tool-format differences we want to understand and test.

## Consequences

- An adapter contract test is needed: the same scripted input must produce the same output shape from both adapters.
- Prompts and tools must work on both models, or the eval comparison will show where they don't — which is the point.
- Local evals cannot run in CI (GitHub runners can't reach LM Studio); Claude evals run on demand.

## Update 2026-11-16: Claude Haiku 5.5 instead of Opus 5.5

- **Why:** cost, on a $5 starting budget. Price per million input / output tokens: Opus 5.5 $4 / $20,
  Sonnet 5.5 $2 / $10, **Haiku 5.5 $0.10 / $0.50** (prompts up to 100K tokens), so about 40× cheaper than Opus.
  The job (qualify a buyer, call 6 simple tools, short replies) is the kind of high-volume, simple tool use Haiku
  is made for. (Sonnet 5.5 was the default for a few hours on the same day.)
- **What changes:** the default of `CLAUDE_MODEL`, and the adapter now sends `fallbacks` only to models that have a
  server-side fallback (`supportsServerFallback()`): Haiku 5.5 has none, and Anthropic says not to send it.
  A Haiku refusal comes back as `stop: "refusal"`. Everything else is the same API: no forced `tool_choice` used,
  no `temperature`, thinking blocks replayed unchanged. Effort stays `low` (Haiku 5.5's own default is `medium`).
  Prompt caching works from 512 tokens on Haiku 5.5, so our tools + rules prefix is cached.
- **Risk:** a smaller model may skip tool calls or miss rules more often. The Phase 4 evals measure this, and
  Sonnet 5.5 / Opus 5.5 are one setting away (`CLAUDE_MODEL=...`) for a comparison row if the numbers are weak.
- **Open for Phase 4:** the LLM judge is also Haiku 5.5. A model grading its own answers can be too kind, so the
  judge should be a different model (for example Sonnet 5.5; judging is few calls, so cheap) or be checked against
  the hand-labelled replies first.
