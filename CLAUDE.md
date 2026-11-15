# dubai-lead-agent

AI agent that qualifies real estate leads for a (fictional) Dubai agency: it chats with buyers,
saves their requirements, searches listings, books viewings and hands off to a human.
Demo project — no real WhatsApp, auth or multi-tenancy.

@AGENTS.md

## Commands

- `npm run dev` — start the app
- `npm run check` — typecheck + lint + format check + unit tests (must pass before you finish)
- `npm run test` — unit tests only (Vitest)
- `npm run format` — format everything with Prettier

## Architecture (must follow)

Layers point one way only: `app → agent → tools → db`. ESLint enforces this.

- `src/app/` UI + API routes. Talks to `@/agent` only.
- `src/agent/` prompts, tool loop, guards. `src/agent/llm/` is the ONLY place that talks to a model provider.
- `src/tools/` one file per tool (Zod schema + implementation).
- `src/db/` schema + seed.

Full details: @docs/architecture.md · Coding rules: @docs/standards.md

## How we work

1. **Plan first.** For any feature, write a short plan in `docs/plans/` and get the human's approval before coding.
2. **Small steps.** One feature at a time. Use the skills in `.claude/skills/` when one fits.
3. **Checks are automatic.** Hooks format/lint each edit and run `npm run check` before you finish. Fix failures; never bypass them.
4. **Never edit `evals/cases/`** to make an eval pass. Fix the agent instead. (A hook asks the human first.)
5. **Never commit or push.** The human reviews and commits. Before handing over, run the `architecture-reviewer` subagent on your changes.
6. **Record decisions.** Any architecture choice → an ADR in `docs/decisions/` (use the `write-adr` skill).
7. **Close the plan.** Mark the plan in `docs/plans/` as done, with what changed and any results (real numbers only).

## Secrets

Never read or print `.env` / `.env.local`. Use `.env.example` to see which variables exist.
