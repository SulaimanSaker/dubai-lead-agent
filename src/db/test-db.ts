import { createDb, migrateDb } from "./client";
import { seedListings } from "./seed";

/** A fresh, isolated in-memory database with all migrations and the seed listings. For tests only. */
export async function createTestDb() {
  const db = createDb(":memory:");
  await migrateDb(db);
  await seedListings(db);
  return db;
}
