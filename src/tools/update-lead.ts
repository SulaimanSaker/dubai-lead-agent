import { eq } from "drizzle-orm";
import { z } from "zod";
import { FINANCING, PURPOSES, TIMELINES, leads } from "@/db/schema";
import { ensureLead, leadSummary, missingLeadFields } from "@/tools/lib/leads";
import { defineTool } from "@/tools/types";

const inputSchema = z
  .object({
    purpose: z.enum(PURPOSES).optional().describe("'rent' or 'sale' (buying)."),
    areas: z
      .array(z.string().trim().min(2).max(60))
      .min(1)
      .max(5)
      .optional()
      .describe("Areas the buyer wants, e.g. ['Dubai Marina', 'JLT']. Replaces the previous list."),
    beds: z.coerce
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe("Bedrooms wanted. 0 = studio."),
    budgetAed: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Maximum budget in AED: yearly rent for rentals, total price for sales. '120k' = 120000.",
      ),
    timeline: z
      .enum(TIMELINES)
      .optional()
      .describe(
        "When they want to move or buy: asap, 1_3_months, 3_6_months, 6_plus_months, browsing.",
      ),
    financing: z.enum(FINANCING).optional().describe("'cash' or 'mortgage'."),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: "Provide at least one field to save.",
  });

export const updateLead = defineTool({
  name: "update_lead",
  description:
    "Save what the buyer has told you about their needs: purpose, areas, bedrooms, budget, timeline, cash or " +
    "mortgage. Call it as soon as the buyer shares any of these — in the same turn as other tools if needed. " +
    "Only send fields the buyer actually stated; earlier fields are kept. Returns which fields are still missing.",
  inputSchema,
  async run(input, ctx) {
    const lead = await ensureLead(ctx);

    // Only the fields the buyer stated this time. Everything else stays as it was.
    const changes = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as Partial<typeof input>;
    const merged = { ...lead, ...changes };
    const missing = missingLeadFields(merged);
    const status = lead.status === "new" && missing.length === 0 ? "qualified" : lead.status;

    await ctx.db
      .update(leads)
      .set({ ...changes, status, updatedAt: ctx.now.toISOString() })
      .where(eq(leads.id, ctx.leadId));

    return {
      ok: true as const,
      lead: leadSummary({ ...merged, status }),
      missing,
      message:
        missing.length === 0
          ? "Lead is fully qualified."
          : `Saved. Still unknown: ${missing.join(", ")}. Ask about these naturally, not all at once.`,
    };
  },
});
