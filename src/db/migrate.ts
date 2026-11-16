import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { Db } from "./client";

/**
 * Apply all committed migrations from src/db/migrations. Safe to run many times.
 *
 * For scripts and tests only (`npm run db:seed`, src/db/test-db.ts), never imported by the app:
 * `new URL(..., import.meta.url)` points somewhere else once Next.js bundles server code.
 */
export async function migrateDb(db: Db) {
  const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
  await migrate(db, { migrationsFolder });
}
