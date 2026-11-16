import { randomUUID } from "node:crypto";
import { z } from "zod";
import { appendMessages, loadConversation } from "@/agent/conversation";
import { getDb } from "@/agent/db";
import { getLeadView, type LeadView } from "@/agent/leads";
import { getProvider, type LlmProvider } from "@/agent/llm";
import { runAgentTurn, type AgentTurnResult, type LoopLimits } from "@/agent/loop";
import type { Db } from "@/db/client";
import { ensureLead } from "@/tools/lib/leads";

/** What the API route may send. Validated here, so every caller gets the same rules. */
export const buyerMessageSchema = z.object({
  leadId: z.uuid().optional().describe("Omit to start a new conversation."),
  message: z.string().trim().min(1, "Message is empty.").max(2000, "Message is too long."),
});

export type BuyerMessage = z.input<typeof buyerMessageSchema>;

export interface ChatDeps {
  db: Db;
  provider: LlmProvider;
  now: () => Date;
  newId: () => string;
  limits?: Partial<LoopLimits>;
}

export interface ChatResponse {
  leadId: string;
  reply: string;
  outcome: AgentTurnResult["outcome"];
  provider: string;
  model: string;
  lead: LeadView;
}

function defaultDeps(): ChatDeps {
  return { db: getDb(), provider: getProvider(), now: () => new Date(), newId: randomUUID };
}

/**
 * Handle one buyer message end to end: create the lead if needed, load the conversation, run the agent,
 * save the new messages, and return the reply with the updated lead.
 *
 * Throws a ZodError for invalid input (the API route turns it into a 400).
 */
export async function handleBuyerMessage(
  input: BuyerMessage,
  deps: ChatDeps = defaultDeps(),
): Promise<ChatResponse> {
  const { leadId: givenId, message } = buyerMessageSchema.parse(input);
  const leadId = givenId ?? deps.newId();
  const now = deps.now();

  await ensureLead({ db: deps.db, leadId, now });
  const history = await loadConversation(deps.db, leadId);
  const result = await runAgentTurn({
    provider: deps.provider,
    db: deps.db,
    leadId,
    history,
    userMessage: message,
    now,
    limits: deps.limits,
  });

  await appendMessages(deps.db, leadId, result.newMessages, now, {
    provider: result.provider,
    model: result.model,
    promptVersion: result.promptVersion,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cachedInputTokens: result.usage.cachedInputTokens,
    latencyMs: result.latencyMs,
    outcome: result.outcome,
  });

  const lead = await getLeadView(deps.db, leadId);
  if (!lead) throw new Error(`Lead ${leadId} disappeared during the turn`);
  return {
    leadId,
    reply: result.reply,
    outcome: result.outcome,
    provider: result.provider,
    model: result.model,
    lead,
  };
}
