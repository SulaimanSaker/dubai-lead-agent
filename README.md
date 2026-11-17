# Dubai Lead Agent

An AI agent that qualifies real estate leads for a fictional Dubai agency. It chats with buyers, saves what they
need (budget, area, bedrooms, timeline, cash or mortgage), searches listings, books viewings and hands off to a
human when it should.

> **Status:** the agent works end to end: buyer chat, lead qualification, listing search, viewing booking,
> handoff, and an agent view. Next: tracing (Langfuse) and evals. See the [plans](docs/plans/README.md) and
> [decisions](docs/decisions/README.md).

## What this repo shows

1. **A reliable AI agent:** tools with validated inputs, guardrails, evals and tracing, on Claude or a local model.
2. **How it was built with Claude Code:** a structured AI-agent engineering workflow, described below.

## How this was built with Claude Code

| Practice                   | Where                                                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project instructions**   | [`CLAUDE.md`](CLAUDE.md), plus folder rules in [`src/agent/CLAUDE.md`](src/agent/CLAUDE.md) and [`evals/CLAUDE.md`](evals/CLAUDE.md)                                                     |
| **Coding standards**       | [`docs/standards.md`](docs/standards.md), enforced by strict TypeScript, ESLint and Prettier                                                                                             |
| **Context management**     | Small root instructions, docs loaded on demand, [ADRs](docs/decisions/README.md), [one plan per feature](docs/plans/README.md)                                                           |
| **Reusable skills**        | [`.claude/skills/`](.claude/skills): add-agent-tool, add-eval-case, change-prompt, write-adr, add-llm-provider                                                                           |
| **Validation checkpoints** | [`.claude/settings.json`](.claude/settings.json) hooks: format + lint every edit, `npm run check` before finishing, protected `.env` and eval cases; CI                                  |
| **Human review**           | Plan approval first, commits only on the human's go-ahead, [`architecture-reviewer`](.claude/agents/architecture-reviewer.md) subagent, [PR checklist](.github/pull_request_template.md) |
| **Architecture-aligned**   | [`docs/architecture.md`](docs/architecture.md) + ESLint layer boundaries (`app → agent → tools → db`)                                                                                    |

## Getting started

```bash
npm install
cp .env.example .env.local   # then pick the model (below)
npm run db:seed              # create local.db: tables + 30 fictional listings
npm run dev                  # http://localhost:3000 → Buyer chat / Agent view
npm run check                # typecheck + lint + format + tests (no model calls)
npm run agent:try            # scripted chats against the real model (smoke test)
```

**Model** (`LLM_PROVIDER` in `.env.local`):

- `claude` (default model Claude Haiku 5.5): sign in once with Anthropic's `ant` CLI (`ant auth login`), or set
  `ANTHROPIC_API_KEY`. A full scripted chat costs well under one cent.
- `local`: start the LM Studio server with `google/gemma-3-4b` loaded **with a context length of at least 16K**
  (`lms load google/gemma-3-4b --context-length 16384`). The default 4K silently cuts the conversation.

**Tracing (optional):** put `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` from a Langfuse project in `.env.local`.
Every buyer message then becomes one trace (model calls, tool calls, tokens, cost, latency), and each conversation
one Langfuse session. Without keys, tracing is off. The agent view also shows cost and trace id per message.

## Docs

- [Architecture](docs/architecture.md) · [Standards](docs/standards.md) · [Decisions](docs/decisions/README.md)
- [Plans](docs/plans/README.md): one plan per feature, approved before any code was written
