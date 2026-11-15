import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "./schema";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

/** Create a Drizzle client. `url` is e.g. "file:local.db" or ":memory:". */
export function createDb(url: string) {
  return drizzle(createClient({ url }), { schema });
}

export type Db = ReturnType<typeof createDb>;

/** Apply all committed migrations from src/db/migrations. Safe to run many times. */
export async function migrateDb(db: Db) {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
