import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { leads } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { handoffToHuman } from "@/tools/handoff-to-human";
import type { ToolContext } from "@/tools/types";

let ctx: ToolContext;

beforeEach(async () => {
  ctx = { db: await createTestDb(), leadId: "lead-1", now: new Date("2026-11-16T05:00:00Z") };
});

describe("handoff_to_human", () => {
  it("marks the lead handed_off with the reason and summary", async () => {
    const result = await handoffToHuman.execute(
      { reason: "asked_for_human", summary: "Buyer asked to speak to a person about a villa." },
      ctx,
    );
    expect(result).toMatchObject({ ok: true, alreadyHandedOff: false });
    const lead = await ctx.db.query.leads.findFirst({ where: eq(leads.id, "lead-1") });
    expect(lead).toMatchObject({
      status: "handed_off",
      handoffReason: "asked_for_human",
      handoffSummary: "Buyer asked to speak to a person about a villa.",
    });
  });

  it("is safe to call twice", async () => {
    const input = { reason: "complaint", summary: "Buyer unhappy with a previous viewing." };
    await handoffToHuman.execute(input, ctx);
    const second = await handoffToHuman.execute(input, ctx);
    expect(second).toMatchObject({ ok: true, alreadyHandedOff: true });
  });

  it("rejects an unknown reason and a too-short summary", async () => {
    expect(
      await handoffToHuman.execute({ reason: "bored", summary: "Buyer wants a person now." }, ctx),
    ).toMatchObject({ ok: false, error: "invalid_input" });
    expect(
      await handoffToHuman.execute({ reason: "negotiation", summary: "discount" }, ctx),
    ).toMatchObject({ ok: false, error: "invalid_input" });
  });
});
