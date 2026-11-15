import { eq } from "drizzle-orm";
import { leads, type Lead } from "@/db/schema";
import type { ToolContext } from "@/tools/types";

/** Fields the agent must collect before a lead counts as qualified. */
export const REQUIRED_LEAD_FIELDS = [
  "purpose",
  "areas",
  "beds",
  "budgetAed",
  "timeline",
  "financing",
] as const satisfies readonly (keyof Lead)[];

/** Get the conversation's lead, creating an empty one on first use. */
export async function ensureLead({ db, leadId, now }: ToolContext): Promise<Lead> {
  const timestamp = now.toISOString();
  await db
    .insert(leads)
    .values({ id: leadId, createdAt: timestamp, updatedAt: timestamp })
    .onConflictDoNothing();
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  if (!lead) throw new Error(`Lead ${leadId} could not be created`);
  return lead;
}

export function missingLeadFields(lead: Lead) {
  return REQUIRED_LEAD_FIELDS.filter((field) => {
    const value = lead[field];
    return value === null || (Array.isArray(value) && value.length === 0);
  });
}

/** Public view of a lead for tool results. */
export function leadSummary(lead: Lead) {
  return {
    purpose: lead.purpose,
    areas: lead.areas,
    beds: lead.beds,
    budgetAed: lead.budgetAed,
    timeline: lead.timeline,
    financing: lead.financing,
    status: lead.status,
  };
}
