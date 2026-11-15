# Architecture

## What the system does

A buyer chats with the agent (WhatsApp-style web chat). The agent:

1. Qualifies the lead — budget, area, bedrooms, timeline, cash or mortgage.
2. Searches listings and answers questions about them.
3. Books viewings in the agent's calendar.
4. Hands off to a human when it should (negotiation, complaints, low confidence, buyer asks for a person).

An agent view page shows each lead's fields, score and a conversation summary.

## Layers

```
src/app      UI + API routes                     ──►  may import: agent
src/agent    prompts, tool loop, guards          ──►  may import: tools, agent/llm
src/agent/llm  model provider adapters           ──►  may import: provider SDKs only
src/tools    one file per tool (Zod + impl)      ──►  may import: db
src/db       schema + seed                       ──►  imports no other layer
evals/       golden cases, checks, runner        ──►  may import: agent, tools
```

**Rule:** imports only point right. The UI never touches the database; tools never call the model.
Enforced by `no-restricted-imports` in `eslint.config.mjs` (also: always use the `@/` alias, never `../`).

## Request flow

```
Buyer message
  → POST /api/chat (src/app)
  → runAgent(conversation) (src/agent/loop.ts)
      → LlmProvider.generate(messages, tools)   (src/agent/llm — Claude or local)
      → model asks for a tool → validate input with Zod → run tool (src/tools) → result back to model
      → repeat until the model replies (max steps + timeout)
  → guards check the reply (no invented prices, handoff rules)
  → reply to buyer + lead fields saved + trace sent to Langfuse
```

## Model layer

`src/agent/llm/` hides which model runs:

- `types.ts` — `LlmProvider` interface: `generate(messages, tools) → { text, toolCalls }`
- `claude.ts` — Claude via the official Anthropic SDK (demo + final evals)
- `local.ts` — Gemma 3 4B in LM Studio via its OpenAI-compatible API (free development + comparison)
- `index.ts` — picks one from `LLM_PROVIDER=claude|local`

Tools are defined once (Zod). Each adapter translates them to its provider's tool format.
See [ADR 0002](decisions/0002-model-layer.md).

## Data

SQLite + Drizzle (see [ADR 0001](decisions/0001-stack.md)). Seeded with about 30 fictional listings
(Dubai Marina, JVC, Downtown, Business Bay, …; AED prices; ready or off-plan) and an agent calendar.

## Observability and evals

- **Tracing:** one Langfuse trace per conversation; spans for each LLM call and tool call; tagged with provider, model, prompt version, tokens, cost, latency.
- **Evals:** golden conversations in `evals/cases/`, code checks + an LLM judge, run per provider and compared. See `evals/CLAUDE.md`.

## Out of scope (on purpose)

Real WhatsApp Business API, authentication, multi-tenancy, payments.
