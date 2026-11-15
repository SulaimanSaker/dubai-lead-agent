# 0003 — libSQL client as the SQLite driver

- **Status:** accepted
- **Date:** 2026-11-15

## Context

ADR 0001 chose SQLite + Drizzle. Drizzle supports several SQLite drivers. The project is developed on Windows
with Node 24, and must also run in CI (Linux) and in tests, where each test needs a fresh, isolated database.

## Decision

- Use **`@libsql/client`** with Drizzle's `drizzle-orm/libsql` driver.
- App and seed script: a local file database (`DATABASE_URL`, default `file:local.db`, git-ignored).
- Tests: a new **in-memory** database per test (`:memory:`), migrated and seeded in milliseconds.
- Schema changes go through **Drizzle Kit migrations** (`npm run db:generate`), committed in `src/db/migrations/`.
  Tests and the seed script apply the same migrations, so they always match the real schema.

## Alternatives considered

- **better-sqlite3** — popular and fast, but a native module that is often compiled on install; risky on Windows
  with a new Node major version. libSQL ships prebuilt binaries.
- **Node's built-in `node:sqlite`** — no dependency, but not a first-class Drizzle driver yet.
- **`drizzle-kit push`** (sync schema without migration files) — quicker, but no reviewable history of schema changes.

## Consequences

- The async libSQL API means all database calls are `await`ed (fine for server code).
- The same client can later point to a hosted libSQL/Turso database by changing `DATABASE_URL`.
- Next.js must treat `@libsql/client` as a server-only package (checked in the model/agent phase).
