import { readAppConfig } from "@/agent/config";
import { createDb, type Db } from "@/db/client";

// One client per server process. Kept on globalThis so Next.js hot reload in development
// doesn't open a new connection on every code change.
const globalForDb = globalThis as typeof globalThis & { __agentDb?: Db };

/**
 * The app's database. It does NOT run migrations: create and update the schema with
 * `npm run db:seed` (scripts and tests only, see ADR 0004).
 */
export function getDb(): Db {
  globalForDb.__agentDb ??= createDb(readAppConfig().DATABASE_URL);
  return globalForDb.__agentDb;
}
