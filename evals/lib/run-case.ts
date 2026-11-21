import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { handleBuyerMessage } from "@/agent/chat";
import { loadConversation, loadTurnMeta } from "@/agent/conversation";
import type { LlmMessage, LlmProvider } from "@/agent/llm";
import type { LoopLimits } from "@/agent/loop";
import type { TurnObserver } from "@/agent/observer";
import type { PromptVersion } from "@/agent/prompts";
import { leads, viewings, type Lead, type Viewing } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { ensureLead } from "@/tools/lib/leads";
import { DEFAULT_NOW, type EvalCase } from "./cases";

export interface TurnRecord {
  message: string;
  reply: string;
  outcome: string;
  /** The model that answered (from the response, not the config). */
  model: string;
}

/** Everything a grader may look at after one run of a case. */
export interface CaseRun {
  turns: TurnRecord[];
  /** The saved conversation, exactly as the model saw it. */
  conversation: LlmMessage[];
  /** The lead at the end (the end state the checks grade). */
  lead: Lead;
  /** Viewings booked by THIS buyer (setup bookings by others are excluded). */
  viewings: Viewing[];
  /** Per-turn facts saved by the agent: tokens, cost, latency, outcome, trace id. */
  metas: Record<string, unknown>[];
}

export interface RunCaseOptions {
  observer?: TurnObserver;
  traceTags?: string[];
  limits?: Partial<LoopLimits>;
  /** Default: the app's current prompt. */
  prompt?: PromptVersion;
}

/**
 * Run one case through the real entry point (`handleBuyerMessage`), in a fresh in-memory database with the
 * seed listings, at the case's fixed "now". Throws only for harness problems; model problems are in the run.
 */
export async function runCase(
  evalCase: EvalCase,
  provider: LlmProvider,
  options: RunCaseOptions = {},
): Promise<CaseRun> {
  const db = await createTestDb();
  const now = new Date(evalCase.now ?? DEFAULT_NOW);

  // State before the chat, e.g. a slot already taken by another buyer.
  for (const [i, booking] of (evalCase.setup?.bookedViewings ?? []).entries()) {
    const other = `setup-buyer-${i}`;
    await ensureLead({ db, leadId: other, now });
    await db.insert(viewings).values({
      id: `setup-viewing-${i}`,
      leadId: other,
      listingId: booking.listingId,
      startsAt: new Date(booking.startsAt).toISOString(),
      status: "booked",
      createdAt: now.toISOString(),
    });
  }

  const leadId = randomUUID();
  const turns: TurnRecord[] = [];
  for (const message of evalCase.messages) {
    const response = await handleBuyerMessage(
      { leadId, message },
      {
        db,
        provider,
        now: () => now,
        newId: () => leadId,
        observer: options.observer,
        traceTags: options.traceTags,
        limits: options.limits,
        prompt: options.prompt,
      },
    );
    turns.push({
      message,
      reply: response.reply,
      outcome: response.outcome,
      model: response.model,
    });
  }

  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  if (!lead) throw new Error(`Harness: lead ${leadId} missing after the conversation`);
  return {
    turns,
    conversation: await loadConversation(db, leadId),
    lead,
    viewings: await db.select().from(viewings).where(eq(viewings.leadId, leadId)),
    metas: (await loadTurnMeta(db, leadId)).map((row) => row.meta ?? {}),
  };
}
