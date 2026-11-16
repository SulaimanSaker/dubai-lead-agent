import { asc, desc, eq } from "drizzle-orm";
import { loadConversation, loadTurnMeta } from "@/agent/conversation";
import type { Db } from "@/db/client";
import { leads, listings, viewings, type Lead } from "@/db/schema";
import { formatSlot } from "@/tools/lib/calendar";
import { missingLeadFields, REQUIRED_LEAD_FIELDS } from "@/tools/lib/leads";

const REQUIRED_FIELD_COUNT = REQUIRED_LEAD_FIELDS.length;

/**
 * Lead score, 0–100, computed in code (not by the model), so it is explainable and repeatable.
 * Known needs 50 · timeline up to 20 · financing up to 15 · a booked viewing 15.
 */
const TIMELINE_POINTS: Record<NonNullable<Lead["timeline"]>, number> = {
  asap: 20,
  "1_3_months": 15,
  "3_6_months": 8,
  "6_plus_months": 4,
  browsing: 0,
};
const FINANCING_POINTS: Record<NonNullable<Lead["financing"]>, number> = { cash: 15, mortgage: 10 };

export type ScoreLabel = "hot" | "warm" | "cold";

export function scoreLead(
  lead: Lead,
  bookedViewings: number,
): { value: number; label: ScoreLabel } {
  let value = 0;
  if (lead.purpose) value += 10;
  if (lead.areas && lead.areas.length > 0) value += 10;
  if (lead.beds !== null) value += 10;
  if (lead.budgetAed !== null) value += 20;
  if (lead.timeline) value += TIMELINE_POINTS[lead.timeline];
  if (lead.financing) value += FINANCING_POINTS[lead.financing];
  if (bookedViewings > 0) value += 15;
  return { value, label: value >= 70 ? "hot" : value >= 40 ? "warm" : "cold" };
}

const TIMELINE_TEXT: Record<NonNullable<Lead["timeline"]>, string> = {
  asap: "as soon as possible",
  "1_3_months": "in 1–3 months",
  "3_6_months": "in 3–6 months",
  "6_plus_months": "in 6+ months",
  browsing: "just browsing",
};

/** One readable line for the human agent, built from the saved fields (no model call). */
export function summarizeLead(lead: Lead, bookedViewings: number): string {
  const nothingKnown = missingLeadFields(lead).length === REQUIRED_FIELD_COUNT;
  const home = lead.beds === null ? "a home" : lead.beds === 0 ? "a studio" : `a ${lead.beds}-bed`;
  const parts = [
    `Wants to ${lead.purpose === "sale" ? "buy" : lead.purpose === "rent" ? "rent" : "rent or buy"} ${home}`,
    lead.areas?.length ? `in ${lead.areas.join(" or ")}` : null,
    lead.budgetAed !== null
      ? `budget AED ${lead.budgetAed.toLocaleString("en-US")}${lead.purpose === "rent" ? " a year" : ""}`
      : null,
    lead.financing ? `paying ${lead.financing === "cash" ? "cash" : "with a mortgage"}` : null,
    lead.timeline ? TIMELINE_TEXT[lead.timeline] : null,
  ].filter(Boolean);
  // The handoff and viewings are always shown, even when no requirement is known yet.
  let summary = nothingKnown ? "No requirements yet." : `${parts.join(", ")}.`;
  if (bookedViewings > 0)
    summary += ` ${bookedViewings} viewing${bookedViewings > 1 ? "s" : ""} booked.`;
  if (lead.status === "handed_off") {
    summary +=
      ` Handed off (${lead.handoffReason ?? "other"}): ${lead.handoffSummary ?? ""}`.trimEnd();
  }
  return summary;
}

export interface TranscriptEntry {
  role: "buyer" | "agent";
  text: string;
  /** Tools the agent used before this reply, e.g. ["update_lead", "search_listings"]. */
  toolsUsed: string[];
}

export interface LeadView {
  id: string;
  status: Lead["status"];
  fields: Pick<Lead, "purpose" | "areas" | "beds" | "budgetAed" | "timeline" | "financing">;
  missing: string[];
  score: { value: number; label: ScoreLabel };
  summary: string;
  handoff: { reason: Lead["handoffReason"]; summary: string | null } | null;
  viewings: { listingId: string; title: string; label: string; status: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface LeadDetail extends LeadView {
  transcript: TranscriptEntry[];
  turns: { createdAt: string; meta: Record<string, unknown> }[];
}

/** Viewings grouped by lead. One query for one lead or for all of them (no query per lead). */
async function loadViewings(db: Db, leadId?: string) {
  const rows = await db
    .select({
      leadId: viewings.leadId,
      listingId: viewings.listingId,
      title: listings.title,
      startsAt: viewings.startsAt,
      status: viewings.status,
    })
    .from(viewings)
    .innerJoin(listings, eq(viewings.listingId, listings.id))
    .where(leadId === undefined ? undefined : eq(viewings.leadId, leadId))
    .orderBy(asc(viewings.startsAt));
  const byLead = new Map<string, LeadView["viewings"]>();
  for (const row of rows) {
    const list = byLead.get(row.leadId) ?? [];
    list.push({
      listingId: row.listingId,
      title: row.title,
      label: formatSlot(new Date(row.startsAt)).label,
      status: row.status,
    });
    byLead.set(row.leadId, list);
  }
  return byLead;
}

function toView(lead: Lead, leadViewings: LeadView["viewings"]): LeadView {
  const booked = leadViewings.filter((v) => v.status === "booked").length;
  return {
    id: lead.id,
    status: lead.status,
    fields: {
      purpose: lead.purpose,
      areas: lead.areas,
      beds: lead.beds,
      budgetAed: lead.budgetAed,
      timeline: lead.timeline,
      financing: lead.financing,
    },
    missing: missingLeadFields(lead),
    score: scoreLead(lead, booked),
    summary: summarizeLead(lead, booked),
    handoff:
      lead.status === "handed_off"
        ? { reason: lead.handoffReason, summary: lead.handoffSummary }
        : null,
    viewings: leadViewings,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
  };
}

export async function getLeadView(db: Db, leadId: string): Promise<LeadView | null> {
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  if (!lead) return null;
  return toView(lead, (await loadViewings(db, leadId)).get(leadId) ?? []);
}

/** Lead details for the agent view: the lead plus a readable transcript and per-turn facts. */
export async function getLeadDetail(db: Db, leadId: string): Promise<LeadDetail | null> {
  const view = await getLeadView(db, leadId);
  if (!view) return null;
  const transcript = await loadTranscript(db, leadId);
  const turns = (await loadTurnMeta(db, leadId)).map((row) => ({
    createdAt: row.createdAt,
    meta: row.meta ?? {},
  }));
  return { ...view, transcript, turns };
}

/**
 * What the buyer's chat page may see: the bubbles and the lead summary. No tool names or model data
 * (those are for the agent view only).
 */
export async function getChatView(
  db: Db,
  leadId: string,
): Promise<{ lead: LeadView; messages: { role: "buyer" | "agent"; text: string }[] } | null> {
  const lead = await getLeadView(db, leadId);
  if (!lead) return null;
  const messages = (await loadTranscript(db, leadId)).map(({ role, text }) => ({ role, text }));
  return { lead, messages };
}

/** Buyer messages and final agent replies, with the tools the agent used before each reply. */
async function loadTranscript(db: Db, leadId: string): Promise<TranscriptEntry[]> {
  const transcript: TranscriptEntry[] = [];
  let toolsUsed: string[] = [];
  for (const message of await loadConversation(db, leadId)) {
    if (message.role === "user") {
      transcript.push({ role: "buyer", text: message.text, toolsUsed: [] });
    }
    if (message.role === "assistant") {
      toolsUsed.push(...message.toolCalls.map((call) => call.name));
      if (message.toolCalls.length === 0) {
        transcript.push({ role: "agent", text: message.text, toolsUsed });
        toolsUsed = [];
      }
    }
  }
  return transcript;
}

/** All leads, most recently active first. */
export async function listLeads(db: Db): Promise<LeadView[]> {
  const [rows, viewingsByLead] = await Promise.all([
    db.select().from(leads).orderBy(desc(leads.updatedAt)),
    loadViewings(db),
  ]);
  return rows.map((lead) => toView(lead, viewingsByLead.get(lead.id) ?? []));
}
