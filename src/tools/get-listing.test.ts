import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@/db/test-db";
import { getListing } from "@/tools/get-listing";
import type { ToolContext } from "@/tools/types";

let ctx: ToolContext;

beforeEach(async () => {
  ctx = { db: await createTestDb(), leadId: "lead-1", now: new Date("2026-11-16T05:00:00Z") };
});

describe("get_listing", () => {
  it("returns full details, including features and payment plan info", async () => {
    const result = await getListing.execute({ listingId: "L06" }, ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(result.listing).toMatchObject({
      id: "L06",
      status: "off_plan",
      handoverDate: "2028-06",
      priceAed: 2_350_000,
    });
    expect(result.listing.features).toContain("payment plan 60/40");
  });

  it("accepts a lowercase id", async () => {
    const result = await getListing.execute({ listingId: "l02" }, ctx);
    expect(result).toMatchObject({ ok: true, listing: { id: "L02" } });
  });

  it("returns not_found for an unknown id, pointing the model to search_listings", async () => {
    const result = await getListing.execute({ listingId: "L99" }, ctx);
    expect(result).toMatchObject({ ok: false, error: "not_found" });
    if (result.ok) throw new Error("expected error");
    expect(result.message).toContain("search_listings");
  });

  it("rejects a missing id", async () => {
    const result = await getListing.execute({}, ctx);
    expect(result).toMatchObject({ ok: false, error: "invalid_input" });
  });
});
