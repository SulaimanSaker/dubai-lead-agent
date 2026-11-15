# Dubai Lead Agent

An AI agent that qualifies real estate leads for a fictional Dubai agency. It chats with buyers, saves what they
need (budget, area, bedrooms, timeline, cash or mortgage), searches listings, books viewings and hands off to a
human when it should.

> **Status:** project setup and AI engineering workflow done. The agent itself is being built next.
> See the [plans](docs/plans/README.md) and [decisions](docs/decisions/README.md).

## What this repo shows

1. **A reliable AI agent:** tools with validated inputs, guardrails, evals and tracing, on Claude or a local model.
2. **How it was built with Claude Code:** a structured AI-agent engineering workflow, described below.

## How this was built with Claude Code

| Practice                   | Where                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Project instructions**   | [`CLAUDE.md`](CLAUDE.md), plus folder rules in [`src/agent/CLAUDE.md`](src/agent/CLAUDE.md) and [`evals/CLAUDE.md`](evals/CLAUDE.md)                                     |
| **Coding standards**       | [`docs/standards.md`](docs/standards.md), enforced by strict TypeScript, ESLint and Prettier                                                                             |
| **Context management**     | Small root instructions, docs loaded on demand, [ADRs](docs/decisions/README.md), [one plan per feature](docs/plans/README.md)                                           |
| **Reusable skills**        | [`.claude/skills/`](.claude/skills): add-agent-tool, add-eval-case, change-prompt, write-adr, add-llm-provider                                                           |
| **Validation checkpoints** | [`.claude/settings.json`](.claude/settings.json) hooks: format + lint every edit, `npm run check` before finishing, protected `.env` and eval cases; CI                  |
| **Human review**           | Plan approval first, Claude never commits, [`architecture-reviewer`](.claude/agents/architecture-reviewer.md) subagent, [PR checklist](.github/pull_request_template.md) |
| **Architecture-aligned**   | [`docs/architecture.md`](docs/architecture.md) + ESLint layer boundaries (`app → agent → tools → db`)                                                                    |

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in what you need
npm run dev                  # http://localhost:3000
npm run check                # typecheck + lint + format + tests
```

Local model: start the LM Studio server with `google/gemma-3-4b` loaded and set `LLM_PROVIDER=local`.

## Docs

- [Architecture](docs/architecture.md) · [Standards](docs/standards.md) · [Decisions](docs/decisions/README.md)
- [Plans](docs/plans/README.md): one plan per feature, approved before any code was written
