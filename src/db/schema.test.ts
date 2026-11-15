import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { leads, viewings } from "@/db/schema";
import { seedListings } from "@/db/seed";
import { createTestDb } from "@/db/test-db";

let db: Db;
const at = "2026-11-17T06:00:00.000Z";
const viewing = (id: string, status: "booked" | "cancelled" = "booked") => ({
  id,
  leadId: "lead-1",
  listingId: "L02",
  startsAt: at,
  status,
  createdAt: at,
});

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(leads).values({ id: "lead-1", createdAt: at, updatedAt: at });
});

describe("viewings table", () => {
  it("refuses two booked viewings at the same time, even without the app check", async () => {
    await db.insert(viewings).values(viewing("v1"));
    await expect(db.insert(viewings).values(viewing("v2"))).rejects.toThrow();
  });

  it("allows a new booking where an earlier one was cancelled", async () => {
    await db.insert(viewings).values(viewing("v1", "cancelled"));
    await expect(db.insert(viewings).values(viewing("v2"))).resolves.toBeDefined();
  });
});

describe("seeding", () => {
  it("can run again after a viewing was booked (review fix)", async () => {
    await db.insert(viewings).values(viewing("v1"));
    await expect(seedListings(db)).resolves.not.toThrow();
    expect(await db.query.listings.findMany()).toHaveLength(30);
    expect(await db.select().from(viewings)).toHaveLength(1);
  });
});

describe("seed data", () => {
  it("has 30 listings with unique ids and positive prices", async () => {
    const rows = await db.query.listings.findMany();
    expect(rows).toHaveLength(30);
    expect(new Set(rows.map((r) => r.id)).size).toBe(30);
    expect(rows.every((r) => r.priceAed > 0)).toBe(true);
    expect(rows.filter((r) => r.status === "off_plan").every((r) => r.handoverDate)).toBe(true);
  });
});
