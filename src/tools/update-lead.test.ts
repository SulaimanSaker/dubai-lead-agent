import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { leads } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import type { ToolContext } from "@/tools/types";
import { updateLead } from "@/tools/update-lead";

let ctx: ToolContext;

beforeEach(async () => {
  ctx = { db: await createTestDb(), leadId: "lead-1", now: new Date("2026-11-16T05:00:00Z") };
});

const storedLead = () => ctx.db.query.leads.findFirst({ where: eq(leads.id, "lead-1") });

describe("update_lead", () => {
  it("creates the lead on first use and saves the stated fields (the cash-buyer case)", async () => {
    const result = await updateLead.execute(
      { purpose: "rent", areas: ["Dubai Marina"], beds: 2, budgetAed: 120_000, financing: "cash" },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      lead: { purpose: "rent", beds: 2, budgetAed: 120_000, financing: "cash", status: "new" },
      missing: ["timeline"],
    });
    expect(await storedLead()).toMatchObject({ areas: ["Dubai Marina"], financing: "cash" });
  });

  it("merges partial updates without erasing earlier fields", async () => {
    await updateLead.execute({ purpose: "sale", budgetAed: 2_000_000 }, ctx);
    await updateLead.execute({ financing: "mortgage" }, ctx);
    expect(await storedLead()).toMatchObject({
      purpose: "sale",
      budgetAed: 2_000_000,
      financing: "mortgage",
    });
  });

  it("marks the lead qualified once every required field is known", async () => {
    await updateLead.execute({ purpose: "rent", areas: ["JVC"], beds: 1 }, ctx);
    const result = await updateLead.execute(
      { budgetAed: 70_000, timeline: "1_3_months", financing: "cash" },
      ctx,
    );
    expect(result).toMatchObject({ ok: true, missing: [], lead: { status: "qualified" } });
    expect((await storedLead())?.status).toBe("qualified");
  });

  it("treats null and empty fields as 'not provided', never as a studio (review fix)", async () => {
    await updateLead.execute({ beds: 2 }, ctx);
    const result = await updateLead.execute({ beds: null, budgetAed: "", financing: "cash" }, ctx);
    expect(result).toMatchObject({
      ok: true,
      lead: { beds: 2, budgetAed: null, financing: "cash" },
    });
    expect((await storedLead())?.beds).toBe(2);
  });

  it("accepts numbers sent as strings", async () => {
    const result = await updateLead.execute({ budgetAed: "150000" }, ctx);
    expect(result).toMatchObject({ ok: true, lead: { budgetAed: 150_000 } });
  });

  it("rejects an empty update and invalid values", async () => {
    expect(await updateLead.execute({}, ctx)).toMatchObject({ ok: false, error: "invalid_input" });
    expect(await updateLead.execute({ financing: "crypto" }, ctx)).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
  });
});
