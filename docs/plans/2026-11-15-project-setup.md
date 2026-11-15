# Project setup and AI engineering workflow

**Goal:** set up the project and the rules for AI-assisted development before writing any feature code.

**Files to add/change:**

- Next.js 16 app (TypeScript strict), Zod, Prettier, Vitest; `npm run check`
- ESLint layer boundaries (`app → agent → tools → db`, provider SDKs only in `src/agent/llm/`)
- `CLAUDE.md` + `src/agent/CLAUDE.md` + `evals/CLAUDE.md`
- `docs/architecture.md`, `docs/standards.md`, ADR 0001 (stack), ADR 0002 (model layer), plan template
- `.claude/settings.json` hooks + permissions, `.claude/hooks/*.mjs`
- `.claude/skills/` (5 skills), `.claude/agents/architecture-reviewer.md`
- PR template, CI workflow, `.env.example`, README

**Steps:**

1. Create the app and tooling; make `npm run check` pass.
2. Add ESLint boundaries; prove them with files that break the rules on purpose.
3. Write instructions, architecture, standards and ADRs.
4. Add hooks: guard `.env` and `evals/cases/` before edits; format + lint after edits; `npm run check` before finishing.
5. Add skills, reviewer subagent, PR template and CI.

**Tests:**

- `npm run check` passes on a clean tree.
- ESLint reports all 3 deliberate boundary violations (app → db, provider SDK outside `llm/`, `../` import).
- Each hook tested with sample input: `.env.local` denied, `.env.example` allowed, `evals/cases/*` asks,
  badly formatted file fixed, lint error sent back (exit 2), type error blocks finishing, `stop_hook_active` doesn't loop.

**Risks / open questions:**

- Hooks must work on Windows (Git Bash paths) as well as Linux/macOS → hooks written in Node, not shell.
- Drizzle + SQLite moved to the data phase, where they're first used.

**Status:** done

**Result:** all checks green; all hook and boundary tests behaved as expected. Notable fixes: `@types/node` raised
to ^24 for Vitest 5; `typecheck` runs `next typegen` first (Next.js 16 generates `LayoutProps`/`PageProps`);
the Stop hook caught four unformatted files written before the hooks existed.
