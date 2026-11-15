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
  - `claude.ts` — **Claude Opus 5.5** (`claude-opus-5-5`) through the official Anthropic SDK. Used for the demo and final evals.
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
