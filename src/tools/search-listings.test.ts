import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@/db/test-db";
import { searchListings } from "@/tools/search-listings";
import type { ToolContext } from "@/tools/types";

let ctx: ToolContext;

beforeEach(async () => {
  ctx = { db: await createTestDb(), leadId: "lead-1", now: new Date("2026-11-16T05:00:00Z") };
});

describe("search_listings", () => {
  it("finds the 2-bed Marina rental within 120k (the cash-buyer case)", async () => {
    const result = await searchListings.execute(
      { purpose: "rent", area: "Dubai Marina", beds: 2, maxPriceAed: 120_000 },
      ctx,
    );
    expect(result).toMatchObject({ ok: true, total: 1 });
    if (!result.ok) throw new Error("expected ok");
    expect(result.listings.map((l) => l.id)).toEqual(["L02"]);
    expect(result.listings[0]?.priceAed).toBe(115_000);
  });

  it("understands short area names like JVC and 'marina'", async () => {
    const jvc = await searchListings.execute({ area: "JVC" }, ctx);
    const marina = await searchListings.execute({ area: "marina", purpose: "rent" }, ctx);
    expect(jvc).toMatchObject({ ok: true, total: 4 });
    expect(marina).toMatchObject({ ok: true, total: 4 });
  });

  it("returns at most 5 results, cheapest first", async () => {
    const result = await searchListings.execute({ purpose: "rent" }, ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(result.total).toBe(16);
    expect(result.listings).toHaveLength(5);
    const prices = result.listings.map((l) => l.priceAed);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it("accepts numbers sent as strings (models sometimes do this)", async () => {
    const result = await searchListings.execute({ beds: "0", purpose: "rent" }, ctx);
    // Rental studios in the seed data: L05, L07, L15, L26.
    expect(result).toMatchObject({ ok: true, total: 4 });
  });

  it("says when the budget is the only problem", async () => {
    const result = await searchListings.execute(
      { purpose: "rent", area: "Palm Jumeirah", maxPriceAed: 100_000 },
      ctx,
    );
    expect(result).toMatchObject({ ok: true, total: 0, listings: [] });
    if (!result.ok) throw new Error("expected ok");
    expect(result.message).toContain("match if the price limit is removed");
  });

  it("ignores null filters instead of searching for studios (review fix)", async () => {
    const result = await searchListings.execute({ purpose: "rent", beds: null, area: null }, ctx);
    expect(result).toMatchObject({ ok: true, total: 16 });
  });

  it("always gives a next step when nothing matches, even without a budget (review fix)", async () => {
    const result = await searchListings.execute({ area: "Arabian Ranches", beds: 0 }, ctx);
    expect(result).toMatchObject({ ok: true, total: 0 });
    if (!result.ok) throw new Error("expected ok");
    expect(result.message).toContain("flexible");
  });

  it("rejects invalid input with a readable message instead of throwing", async () => {
    const result = await searchListings.execute({ purpose: "lease", beds: -1 }, ctx);
    expect(result).toMatchObject({ ok: false, error: "invalid_input" });
    if (result.ok) throw new Error("expected error");
    expect(result.message).toContain("purpose");
    expect(result.message).toContain("beds");
  });
});
