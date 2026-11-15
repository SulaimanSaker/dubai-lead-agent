# 0001 — Stack

- **Status:** accepted
- **Date:** 2026-11-15

## Context

A weekend demo of an AI lead-qualification agent. It must be quick to build, easy to run on a Windows laptop,
and show production habits (types, validation, tests, CI). The builder's strongest stack is React/TypeScript/Next.js.

## Decision

- **Next.js 16 (App Router) + TypeScript (strict)** — UI and API routes in one app.
- **Zod** — one schema per tool, used both for the model's tool definition and for validating its input.
- **SQLite + Drizzle** — a file database, no server to install. Drizzle gives typed queries.
- **Vitest** — fast unit tests, same config style as Vite.
- **Prettier + ESLint** — formatting and architecture boundaries.
- **Langfuse** — tracing for LLM and tool calls (free cloud tier).
- **GitHub Actions** — CI.

## Alternatives considered

- **Postgres** — production-like, but needs a server or Docker. Not worth it for a demo; Drizzle makes a later switch small.
- **Separate backend (Nest.js)** — more structure, but two apps to run. Next.js API routes are enough here.
- **LangChain / agent frameworks** — hide the tool loop. Writing the loop ourselves shows we understand it and keeps full control.

## Consequences

- One `npm run dev` runs everything.
- SQLite is single-writer; fine for a demo, not for production traffic.
