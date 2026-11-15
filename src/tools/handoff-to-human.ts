import { eq } from "drizzle-orm";
import { z } from "zod";
import { HANDOFF_REASONS, leads } from "@/db/schema";
import { ensureLead } from "@/tools/lib/leads";
import { defineTool } from "@/tools/types";

export const handoffToHuman = defineTool({
  name: "handoff_to_human",
  description:
    "Hand the conversation to a human agent. Use it when the buyer wants to negotiate the price, complains, " +
    "asks for a person, or when you can't help after trying. After calling it, tell the buyer a human agent " +
    "will contact them — don't promise a specific time.",
  inputSchema: z.object({
    reason: z.enum(HANDOFF_REASONS).describe("negotiation, complaint, asked_for_human, or other."),
    summary: z
      .string()
      .trim()
      .min(10)
      .max(500)
      .describe(
        "2–3 sentences for the human agent: what the buyer wants and why you are handing off.",
      ),
  }),
  async run({ reason, summary }, ctx) {
    const lead = await ensureLead(ctx);
    if (lead.status === "handed_off") {
      return {
        ok: true as const,
        alreadyHandedOff: true,
        message: "Already handed off. A human agent will contact the buyer.",
      };
    }
    await ctx.db
      .update(leads)
      .set({
        status: "handed_off",
        handoffReason: reason,
        handoffSummary: summary,
        updatedAt: ctx.now.toISOString(),
      })
      .where(eq(leads.id, ctx.leadId));
    return {
      ok: true as const,
      alreadyHandedOff: false,
      message: "Handed off. Tell the buyer a human agent will contact them shortly.",
    };
  },
});
