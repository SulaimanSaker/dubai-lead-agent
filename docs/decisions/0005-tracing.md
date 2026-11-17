# 0005 — Tracing with Langfuse behind an observer interface

- **Status:** accepted
- **Date:** 2026-11-16

## Context

We need to see what the agent did for each buyer message: every model call (input, output, tokens, cost,
latency) and every tool call, tagged with provider, model and prompt version, so we can debug, compare models and
link eval results to real traces. The agent already records per-turn facts in the database (`messages.meta`);
that is not enough to inspect single model calls.

Langfuse's current TypeScript SDK (v6, `@langfuse/tracing` + `@langfuse/otel`) is built on OpenTelemetry. Trace
attributes such as the session id are set with `propagateAttributes(params, fn)` and apply to spans created
inside `fn`.

## Decision

- **Langfuse Cloud (EU region)** stores traces. One trace per buyer message (`agent-turn`), grouped by
  `sessionId = leadId`; child observations: a `generation` per model call, a `tool` per tool call, a `guardrail`
  when the price guard fires.
- **The agent talks to a `TurnObserver` interface** (`src/agent/observer.ts`), not to Langfuse. The loop reports
  model calls, tool calls and guard events; `chat.ts` wraps the turn. The default observer does nothing.
- **Only `src/agent/tracing/` may import `@langfuse/*` and `@opentelemetry/*`** (ESLint), like provider SDKs in
  `src/agent/llm/`.
- **Tracing is optional and can't break a chat:** without `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` it stays
  off; observer errors are caught and logged; export happens in the background. Scripts flush before exiting.
- **Cost is computed in our code** (`src/agent/llm/pricing.ts`, dated price table) and sent to Langfuse, saved in
  the turn meta and shown in the agent view, so all three show the same number.

## Alternatives considered

- **Call Langfuse directly in the loop:** fewer files, but ties the core loop to one vendor's SDK and makes the
  loop harder to test.
- **Anthropic SDK's built-in OpenTelemetry spans:** cover Claude only, not the local model or our tools.
- **Our own tables only (no tracing tool):** cheap, but no timeline view, no search, no sessions, no comparison
  across runs.
- **Self-hosted Langfuse (Docker):** data stays local, but several containers to run; Cloud is free at this scale.
- **One trace per conversation:** conversations can last days; one trace per message keeps traces small and
  comparable, and the session still shows the whole conversation.

## Consequences

- Buyer messages, replies and tool results are sent to Langfuse Cloud. Fine for fictional demo data; a real
  deployment would add masking (`LangfuseSpanProcessor` supports it) and a data-processing agreement.
- The price table must be kept up to date (it records its date and source).
- Evals (Phase 4) can reuse the same observer, so every eval run is traced too.
