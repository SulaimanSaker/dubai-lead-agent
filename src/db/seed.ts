import { getTableColumns, sql } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "./client";
import { listings } from "./schema";
import { SEED_LISTINGS } from "./seed-data";

/**
 * Insert or update the fixed seed listings (matched by id). Leads and viewings are left alone.
 * Upsert, not delete + insert: viewings reference listings, so deleting a booked listing would fail.
 */
export async function seedListings(db: Db) {
  const updateAll = Object.fromEntries(
    Object.entries(getTableColumns(listings))
      .filter(([key]) => key !== "id")
      .map(([key, column]) => [key, sql.raw(`excluded.${column.name}`)]),
  );
  await db
    .insert(listings)
    .values(SEED_LISTINGS)
    .onConflictDoUpdate({ target: listings.id, set: updateAll });
}

// `npm run db:seed`: migrate + seed the local database.
async function main() {
  const url = process.env.DATABASE_URL ?? "file:local.db";
  const db = createDb(url);
  await migrateDb(db);
  await seedListings(db);
  console.log(`Seeded ${SEED_LISTINGS.length} listings into ${url}`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("src/db/seed.ts")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
