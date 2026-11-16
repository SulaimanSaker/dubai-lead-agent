import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

/**
 * Create a Drizzle client. `url` is e.g. "file:local.db" or ":memory:".
 * The app imports this module, so it must stay free of file-system paths (see migrate.ts).
 */
export function createDb(url: string) {
  return drizzle(createClient({ url }), { schema });
}

export type Db = ReturnType<typeof createDb>;
