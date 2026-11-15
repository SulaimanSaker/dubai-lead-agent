import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@/db/test-db";
import { bookViewing } from "@/tools/book-viewing";
import { getAvailableSlots } from "@/tools/get-available-slots";
import type { ToolContext } from "@/tools/types";

let ctx: ToolContext;

beforeEach(async () => {
  // Monday 16 Nov 2026, 09:00 Dubai time
  ctx = { db: await createTestDb(), leadId: "lead-1", now: new Date("2026-11-16T05:00:00Z") };
});

describe("get_available_slots", () => {
  it("lists hourly slots from 10:00, in Dubai time, starting today", async () => {
    const result = await getAvailableSlots.execute({}, ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(result.checked).toEqual({ from: "2026-11-16", to: "2026-11-18" });
    expect(result.slots[0]).toEqual({
      startsAt: "2026-11-16T10:00:00+04:00",
      label: "Mon 16 Nov 2026, 10:00",
    });
    // 3 working days × 8 slots (10:00 … 17:00)
    expect(result.slots).toHaveLength(24);
    expect(result.slots.at(-1)?.label).toBe("Wed 18 Nov 2026, 17:00");
  });

  it("needs at least 1 hour notice", async () => {
    ctx.now = new Date("2026-11-16T05:30:00Z"); // 09:30 Dubai
    const result = await getAvailableSlots.execute({ days: 1 }, ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(result.slots[0]?.label).toBe("Mon 16 Nov 2026, 11:00");
  });

  it("has no slots on Sunday", async () => {
    const result = await getAvailableSlots.execute({ fromDate: "2026-11-22", days: 1 }, ctx);
    expect(result).toMatchObject({ ok: true, slots: [] });
  });

  it("hides slots that are already booked", async () => {
    await bookViewing.execute({ listingId: "L02", startsAt: "2026-11-17T10:00:00+04:00" }, ctx);
    const result = await getAvailableSlots.execute({ fromDate: "2026-11-17", days: 1 }, ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(result.slots).toHaveLength(7);
    expect(result.slots.map((s) => s.label)).not.toContain("Tue 17 Nov 2026, 10:00");
  });

  it("says honestly when the list was cut short (review fix)", async () => {
    // 7 days ≈ 48 free slots, but only 24 are returned: it must not claim it checked the whole week.
    const result = await getAvailableSlots.execute({ days: 7 }, ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(result.slots).toHaveLength(24);
    expect(result.truncated).toBe(true);
    expect(result.checked).toEqual({ from: "2026-11-16", to: "2026-11-18" });
    expect(result.message).toContain("Later days were not checked");
  });

  it("refuses to look more than 60 days ahead (review fix)", async () => {
    const result = await getAvailableSlots.execute({ fromDate: "2099-11-17" }, ctx);
    expect(result).toMatchObject({ ok: true, slots: [], checked: null });
    if (!result.ok) throw new Error("expected ok");
    expect(result.message).toContain("60 days ahead");
  });

  it("starts from today if asked for a past date", async () => {
    const result = await getAvailableSlots.execute({ fromDate: "2026-11-01", days: 1 }, ctx);
    expect(result).toMatchObject({ ok: true, checked: { from: "2026-11-16" } });
  });

  it("rejects more than 7 days and bad dates", async () => {
    expect(await getAvailableSlots.execute({ days: 30 }, ctx)).toMatchObject({ ok: false });
    expect(await getAvailableSlots.execute({ fromDate: "next monday" }, ctx)).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
  });
});
