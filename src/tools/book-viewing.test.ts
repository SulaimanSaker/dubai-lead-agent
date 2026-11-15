import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { leads, viewings } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { bookViewing } from "@/tools/book-viewing";
import { handoffToHuman } from "@/tools/handoff-to-human";
import type { ToolContext } from "@/tools/types";

let ctx: ToolContext;

beforeEach(async () => {
  // Monday 16 Nov 2026, 09:00 Dubai time
  ctx = { db: await createTestDb(), leadId: "lead-1", now: new Date("2026-11-16T05:00:00Z") };
});

describe("book_viewing", () => {
  it("books a free slot, stores it in UTC and marks the lead viewing_booked", async () => {
    const result = await bookViewing.execute(
      { listingId: "L02", startsAt: "2026-11-17T10:00:00+04:00" },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      listing: { id: "L02" },
      startsAt: "2026-11-17T10:00:00+04:00",
      label: "Tue 17 Nov 2026, 10:00",
    });
    const [stored] = await ctx.db.select().from(viewings);
    expect(stored?.startsAt).toBe("2026-11-17T06:00:00.000Z");
    const lead = await ctx.db.query.leads.findFirst({ where: eq(leads.id, "lead-1") });
    expect(lead?.status).toBe("viewing_booked");
  });

  it("accepts the same time written in UTC", async () => {
    const result = await bookViewing.execute(
      { listingId: "L02", startsAt: "2026-11-17T06:00:00Z" },
      ctx,
    );
    expect(result).toMatchObject({ ok: true, label: "Tue 17 Nov 2026, 10:00" });
  });

  it("refuses a slot that is already booked", async () => {
    await bookViewing.execute({ listingId: "L02", startsAt: "2026-11-17T10:00:00+04:00" }, ctx);
    const second = await bookViewing.execute(
      { listingId: "L03", startsAt: "2026-11-17T10:00:00+04:00" },
      { ...ctx, leadId: "lead-2" },
    );
    expect(second).toMatchObject({ ok: false, error: "conflict" });
  });

  it("lets only one of two simultaneous requests book the same slot", async () => {
    const results = await Promise.all([
      bookViewing.execute({ listingId: "L02", startsAt: "2026-11-18T12:00:00+04:00" }, ctx),
      bookViewing.execute(
        { listingId: "L03", startsAt: "2026-11-18T12:00:00+04:00" },
        { ...ctx, leadId: "lead-2" },
      ),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toMatchObject([{ error: "conflict" }]);
    expect(await ctx.db.select().from(viewings)).toHaveLength(1);
  });

  it.each([
    ["outside working hours (Friday 09:00)", "2026-11-20T09:00:00+04:00", "10:00 to 18:00"],
    ["after the last slot (17:00 is last)", "2026-11-20T18:00:00+04:00", "10:00 to 18:00"],
    ["on a Sunday", "2026-11-22T11:00:00+04:00", "Sundays"],
    ["in the past", "2026-11-14T11:00:00+04:00", "in the past"],
    ["not on the hour", "2026-11-17T10:30:00+04:00", "on the hour"],
    // Review fixes: no booking window existed, and the label had no year.
    ["more than 60 days ahead", "2027-01-20T11:00:00+04:00", "60 days ahead"],
    ["decades ahead (year 2099)", "2099-11-17T10:00:00+04:00", "60 days ahead"],
  ])("refuses a time %s", async (_case, startsAt, reason) => {
    const result = await bookViewing.execute({ listingId: "L02", startsAt }, ctx);
    expect(result).toMatchObject({ ok: false, error: "not_allowed" });
    if (result.ok) throw new Error("expected error");
    expect(result.message).toContain(reason);
  });

  it("refuses an unknown listing", async () => {
    const result = await bookViewing.execute(
      { listingId: "L99", startsAt: "2026-11-17T10:00:00+04:00" },
      ctx,
    );
    expect(result).toMatchObject({ ok: false, error: "not_found" });
  });

  it("refuses to book for a buyer who was handed to a human", async () => {
    await handoffToHuman.execute(
      { reason: "negotiation", summary: "Buyer wants 10% off the asking price." },
      ctx,
    );
    const result = await bookViewing.execute(
      { listingId: "L02", startsAt: "2026-11-17T10:00:00+04:00" },
      ctx,
    );
    expect(result).toMatchObject({ ok: false, error: "not_allowed" });
  });

  it("rejects a time that is not an ISO date-time", async () => {
    const result = await bookViewing.execute({ listingId: "L02", startsAt: "tomorrow 10am" }, ctx);
    expect(result).toMatchObject({ ok: false, error: "invalid_input" });
  });
});
