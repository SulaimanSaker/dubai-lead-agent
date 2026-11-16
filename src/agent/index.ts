/**
 * The agent's public API. `src/app` imports from here only (ESLint enforces it).
 * `server-only` makes the build fail if this ever ends up in browser code.
 */
import "server-only";
import { handleBuyerMessage, type ChatResponse } from "@/agent/chat";
import { getDb } from "@/agent/db";
import {
  getChatView,
  getLeadDetail,
  listLeads,
  type LeadDetail,
  type LeadView,
} from "@/agent/leads";
import { readLlmConfig } from "@/agent/llm/config";

export { buyerMessageSchema } from "@/agent/chat";
export { DATABASE_NOT_READY_MESSAGE, isDatabaseNotReady } from "@/agent/errors";
export type { ChatResponse } from "@/agent/chat";
export type { LeadDetail, LeadView, ScoreLabel, TranscriptEntry } from "@/agent/leads";

/** Answer one buyer message. `input` is validated inside (a ZodError means a bad request). */
export function sendBuyerMessage(input: unknown): Promise<ChatResponse> {
  return handleBuyerMessage(input);
}

/** A conversation for the buyer's chat page (bubbles + lead summary), or null. */
export function getChat(leadId: string) {
  return getChatView(getDb(), leadId);
}

/** All leads for the agent view, most recently active first. */
export function getLeads(): Promise<LeadView[]> {
  return listLeads(getDb());
}

/** One lead with transcript and per-turn facts, or null. */
export function getLead(leadId: string): Promise<LeadDetail | null> {
  return getLeadDetail(getDb(), leadId);
}

/** Which model answers, for a small label in the UI. Reads settings only; creates no client. */
export function getModelInfo(): { provider: string; model: string } {
  const config = readLlmConfig();
  return config.LLM_PROVIDER === "claude"
    ? { provider: "Claude", model: config.CLAUDE_MODEL }
    : { provider: "Local (LM Studio)", model: config.LMSTUDIO_MODEL };
}
