import { randomUUID } from "node:crypto";
import { z } from "zod";
import { appendMessages, loadConversation } from "@/agent/conversation";
import { getDb } from "@/agent/db";
import { getLeadView, type LeadView } from "@/agent/leads";
import { getProvider, type LlmProvider } from "@/agent/llm";
import { runAgentTurn, type AgentTurnResult, type LoopLimits } from "@/agent/loop";
import { NOOP_OBSERVER, observeTurn, type TurnObserver } from "@/agent/observer";
import { CURRENT_PROMPT, type PromptVersion } from "@/agent/prompts";
import { getTurnObserver } from "@/agent/tracing";
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
  /** Tracing. Default in tests: none; in the app: Langfuse when its keys are set. */
  observer?: TurnObserver;
  /** Extra trace tags (evals tag their runs). */
  traceTags?: string[];
  /** The prompt version to use. Default: CURRENT_PROMPT (evals compare versions). */
  prompt?: PromptVersion;
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
  return {
    db: getDb(),
    provider: getProvider(),
    now: () => new Date(),
    newId: randomUUID,
    observer: getTurnObserver(),
  };
}

/**
 * Handle one buyer message end to end: create the lead if needed, load the conversation, run the agent,
 * save the new messages, and return the reply with the updated lead.
 *
 * Throws a ZodError for invalid input (the API route turns it into a 400).
 */
export async function handleBuyerMessage(
  input: unknown, // a BuyerMessage, validated below
  deps: ChatDeps = defaultDeps(),
): Promise<ChatResponse> {
  const { leadId: givenId, message } = buyerMessageSchema.parse(input);
  const leadId = givenId ?? deps.newId();
  return oneAtATime(leadId, () => runTurn(leadId, message, deps));
}

/**
 * Messages for the same lead run one after another, never at the same time: two at once (a double
 * submit) would both load the same history and save an order the model never saw.
 * In-process only, which is enough for one server; several servers would need a database lock.
 */
const leadQueues = new Map<string, Promise<unknown>>();

function oneAtATime<T>(leadId: string, task: () => Promise<T>): Promise<T> {
  const previous = leadQueues.get(leadId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  leadQueues.set(leadId, next);
  void next
    .finally(() => {
      if (leadQueues.get(leadId) === next) leadQueues.delete(leadId);
    })
    .catch(() => undefined);
  return next;
}

async function runTurn(leadId: string, message: string, deps: ChatDeps): Promise<ChatResponse> {
  const now = deps.now();
  const prompt = deps.prompt ?? CURRENT_PROMPT;

  await ensureLead({ db: deps.db, leadId, now });
  const history = await loadConversation(deps.db, leadId);
  const turnInfo = {
    leadId,
    userMessage: message,
    provider: deps.provider.name,
    model: deps.provider.model,
    promptVersion: prompt.version,
    ...(deps.traceTags && { tags: deps.traceTags }),
  };
  const { result, traceId } = await observeTurn(
    deps.observer ?? NOOP_OBSERVER,
    turnInfo,
    async (trace) => {
      const result = await runAgentTurn({
        provider: deps.provider,
        db: deps.db,
        leadId,
        history,
        userMessage: message,
        now,
        limits: deps.limits,
        prompt,
        trace,
      });
      trace.finish({
        reply: result.reply,
        outcome: result.outcome,
        steps: result.steps,
        usage: result.usage,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
        model: result.model,
        guardEvents: result.guardEvents,
        ...(result.error && { error: result.error }),
      });
      return { result, traceId: trace.traceId };
    },
  );

  await appendMessages(deps.db, leadId, result.newMessages, now, {
    provider: result.provider,
    model: result.model,
    promptVersion: result.promptVersion,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cachedInputTokens: result.usage.cachedInputTokens,
    cacheWriteInputTokens: result.usage.cacheWriteInputTokens,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    outcome: result.outcome,
    traceId,
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
