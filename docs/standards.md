# Coding standards

Rules for humans and AI agents. The ones marked **(enforced)** are checked by tools, not just written here.

## TypeScript

- Strict mode with `noUncheckedIndexedAccess` **(enforced: tsconfig)**.
- No `any` **(enforced: ESLint)**. Use `unknown` and narrow it, or a Zod schema.
- Type-only imports use `import type` **(enforced: ESLint)**.
- Prefer SDK and library types over re-declaring your own (e.g. Anthropic SDK message types).

## Boundaries and validation

- Respect the layers in `docs/architecture.md` **(enforced: ESLint)**.
- Use the `@/` alias, never `../` **(enforced: ESLint)**.
- Validate every outside input with Zod: API request bodies, tool inputs from the model, env variables, eval case files.
- Never trust model output: tool arguments are parsed and validated before running.

## Naming and files

- Files: `kebab-case.ts`. One tool per file in `src/tools/`.
- Functions: verbs (`searchListings`, `bookViewing`). Types: nouns (`Listing`, `LeadFields`).
- Tests sit next to the code: `search-listings.test.ts`.

## Errors

- Expected failures (no listings found, slot taken) are normal return values, not exceptions — the model needs to see them.
- Unexpected failures throw with a clear message; the loop catches them and returns an error result to the model.
- Never swallow errors silently.

## Tests

- Every tool has unit tests (no model calls).
- Bugs get a test that reproduces them before the fix.
- `npm run check` must pass before work is handed over **(enforced: Stop hook)**.

## Formatting

Prettier, 100 columns **(enforced: hook on every edit + CI)**.

## Secrets

- Never commit or print secrets. `.env*` is git-ignored except `.env.example` **(enforced: .gitignore + hooks)**.
