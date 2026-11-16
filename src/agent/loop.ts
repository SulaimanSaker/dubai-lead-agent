import { eq } from "drizzle-orm";
import {
  findInventedPrices,
  priceCorrectionNote,
  safeReply,
  type SafeReplyKind,
} from "@/agent/guards";
import {
  LlmError,
  toAssistantMessage,
  type LlmMessage,
  type LlmProvider,
  type LlmResult,
  type LlmToolCall,
  type LlmUsage,
} from "@/agent/llm";
import { CURRENT_PROMPT, type PromptContext, type PromptVersion } from "@/agent/prompts";
import { TOOL_DEFS } from "@/agent/tool-defs";
import type { Db } from "@/db/client";
import { leads, type Lead } from "@/db/schema";
import { TOOLS_BY_NAME, type ToolContext } from "@/tools";
import { formatSlot } from "@/tools/lib/calendar";
import { handoffToHuman } from "@/tools/handoff-to-human";
import { leadSummary, missingLeadFields } from "@/tools/lib/leads";

export interface LoopLimits {
  /** Model calls per buyer message. */
  maxSteps: number;
  /** Wall-clock budget per buyer message. The running model call is aborted when it is used up. */
  timeoutMs: number;
  /** The same tool failing this often in one turn → automatic handoff to a human. */
  maxToolFailures: number;
}

export const DEFAULT_LIMITS: LoopLimits = { maxSteps: 8, timeoutMs: 90_000, maxToolFailures: 3 };

export interface AgentTurnInput {
  provider: LlmProvider;
  db: Db;
  leadId: string;
  /** The saved conversation before this message. */
  history: LlmMessage[];
  userMessage: string;
  now: Date;
  prompt?: PromptVersion;
  limits?: Partial<LoopLimits>;
}

export interface ToolLogEntry {
  name: string;
  input: unknown;
  ok: boolean;
  /** Why it failed, if it did. */
  error?: string;
  durationMs: number;
}

export interface GuardEvent {
  type: "invented_price";
  amounts: string[];
  action: "retried" | "replaced";
}

/**
 * How the turn ended. Everything except `replied` means the buyer got a fixed safe reply.
 */
export type TurnOutcome =
  | "replied"
  | "price_guard"
  | "tool_failures"
  | "max_steps"
  | "timeout"
  | "provider_error"
  | "refusal"
  | "cut_off";

export interface AgentTurnResult {
  reply: string;
  /** Messages to save, in order: the user message, then every assistant and tool message of this turn. */
  newMessages: LlmMessage[];
  outcome: TurnOutcome;
  toolLog: ToolLogEntry[];
  guardEvents: GuardEvent[];
  /** Summed over every model call of the turn. */
  usage: LlmUsage;
  steps: number;
  latencyMs: number;
  provider: string;
  /** The model that answered last (can differ from the requested one after a fallback). */
  model: string;
  promptVersion: string;
  /** Set when the loop could not finish normally: the error behind `outcome`. */
  error?: string;
}

/** Tool errors that mean "the model is using the tool wrong", not normal results like "slot taken". */
const MISUSE_ERRORS = new Set(["invalid_input", "unknown_tool", "tool_crashed"]);

/**
 * Answer one buyer message: call the model, run the tools it asks for, send the results back,
 * repeat until it replies. Never throws for model or tool problems: those end in a safe reply.
 * Bugs in our own code (not LlmError) are re-thrown.
 */
export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const prompt = input.prompt ?? CURRENT_PROMPT;
  const ctx: ToolContext = { db: input.db, leadId: input.leadId, now: input.now };
  const started = Date.now();

  const userMessage: LlmMessage = { role: "user", text: input.userMessage };
  const conversation: LlmMessage[] = [...input.history, userMessage];
  const newMessages: LlmMessage[] = [userMessage];
  const toolLog: ToolLogEntry[] = [];
  const guardEvents: GuardEvent[] = [];
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  const failures = new Map<string, number>();
  let model = input.provider.model;
  let steps = 0;
  let correction: string | null = null;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), limits.timeoutMs);

  const finish = (
    reply: string,
    outcome: TurnOutcome,
    extra: { assistant?: LlmMessage; error?: string } = {},
  ): AgentTurnResult => {
    // A fixed reply is stored as a plain assistant turn. The previous message is always a user or
    // tool message here, so two assistant turns never follow each other.
    newMessages.push(extra.assistant ?? { role: "assistant", text: reply, toolCalls: [] });
    return {
      reply,
      newMessages,
      outcome,
      toolLog,
      guardEvents,
      usage,
      steps,
      latencyMs: Date.now() - started,
      provider: input.provider.name,
      model,
      promptVersion: prompt.version,
      ...(extra.error && { error: extra.error }),
    };
  };
  const fallback = (kind: SafeReplyKind, outcome: TurnOutcome, error?: string) =>
    finish(safeReply(kind, input.userMessage), outcome, { error });

  // `finally` clears the timer on every path, including errors thrown by our own code.
  try {
    while (steps < limits.maxSteps) {
      steps++;
      const lead = await readLead(input.db, input.leadId, input.now);
      const dynamic = prompt.dynamic(promptContext(lead, input.now));

      let result: LlmResult;
      try {
        result = await input.provider.generate({
          system: {
            stable: prompt.stable,
            dynamic: correction ? `${dynamic}\n\n${correction}` : dynamic,
          },
          messages: conversation,
          tools: [...TOOL_DEFS],
          signal: abort.signal,
        });
      } catch (error) {
        if (!(error instanceof LlmError)) throw error;
        console.error(`[agent] lead ${input.leadId}: ${error.kind}: ${error.message}`);
        return fallback(
          "error",
          error.kind === "timeout" ? "timeout" : "provider_error",
          error.message,
        );
      }
      addUsage(usage, result.usage);
      model = result.model;

      // A tool stop with no usable calls is treated as a text answer (or an empty one below).
      // Saving it as a tool turn would leave an assistant turn with nothing after it.
      if (result.stop === "tool_use" && result.toolCalls.length > 0) {
        const assistant = toAssistantMessage(result);
        conversation.push(assistant);
        newMessages.push(assistant);
        for (const call of result.toolCalls) {
          const toolMessage = await runTool(call, ctx, toolLog);
          conversation.push(toolMessage);
          newMessages.push(toolMessage);
          if (toolMessage.isError && isMisuse(toolMessage.result)) {
            failures.set(call.name, (failures.get(call.name) ?? 0) + 1);
          }
        }
        const failing = [...failures].find(([, count]) => count >= limits.maxToolFailures);
        if (failing) {
          await handoffAfterFailures(ctx, failing[0], toolLog);
          return fallback("handoff", "tool_failures", `${failing[0]} failed ${failing[1]} times`);
        }
        if (abort.signal.aborted) return fallback("error", "timeout", "turn timeout after tools");
        continue;
      }

      if (result.stop === "refusal") return fallback("refusal", "refusal");
      if (result.stop === "max_tokens") return fallback("error", "cut_off");
      if (result.text.trim() === "") return fallback("error", "provider_error", "empty reply");

      // Guard: every price in the reply must come from a tool result in this conversation.
      const invented = findInventedPrices(result.text, toolResults(conversation));
      if (invented.length > 0) {
        const amounts = invented.map((amount) => amount.raw);
        if (correction === null) {
          // Drop the draft (it is never stored) and ask once more with a correction note.
          guardEvents.push({ type: "invented_price", amounts, action: "retried" });
          correction = priceCorrectionNote(invented);
          continue;
        }
        guardEvents.push({ type: "invented_price", amounts, action: "replaced" });
        return fallback("price_check", "price_guard", `invented prices: ${amounts.join(", ")}`);
      }

      return finish(result.text, "replied", { assistant: toAssistantMessage(result) });
    }

    return fallback("error", "max_steps", `no reply after ${limits.maxSteps} model calls`);
  } finally {
    clearTimeout(timer);
  }
}

/** Run one tool call. Every problem becomes an error result the model can read; nothing throws. */
async function runTool(
  call: LlmToolCall,
  ctx: ToolContext,
  toolLog: ToolLogEntry[],
): Promise<Extract<LlmMessage, { role: "tool" }>> {
  const started = Date.now();
  const tool = TOOLS_BY_NAME.get(call.name);
  let result: { ok: boolean; error?: string; message?: string };

  if (!tool) {
    result = {
      ok: false,
      error: "unknown_tool",
      message: `There is no tool called "${call.name}". Use one of: ${[...TOOLS_BY_NAME.keys()].join(", ")}.`,
    };
  } else if (call.inputError) {
    result = { ok: false, error: "invalid_input", message: call.inputError };
  } else {
    try {
      result = await tool.execute(call.input, ctx);
    } catch (error) {
      // A bug or a database problem. Logged for us; the model gets a short, safe message.
      console.error(`[agent] tool ${call.name} crashed for lead ${ctx.leadId}:`, error);
      result = {
        ok: false,
        error: "tool_crashed",
        message: `${call.name} failed unexpectedly. Try again once, or hand off to a human agent.`,
      };
    }
  }

  toolLog.push({
    name: call.name,
    input: call.input,
    ok: result.ok,
    ...(!result.ok && { error: result.error }),
    durationMs: Date.now() - started,
  });
  return {
    role: "tool",
    callId: call.id,
    name: call.name,
    result: JSON.stringify(result),
    isError: !result.ok,
  };
}

function isMisuse(resultJson: string): boolean {
  try {
    const parsed = JSON.parse(resultJson) as { error?: unknown };
    return typeof parsed.error === "string" && MISUSE_ERRORS.has(parsed.error);
  } catch {
    return false;
  }
}

/** Hand off automatically, so a human picks the buyer up. Logged like any tool call. */
async function handoffAfterFailures(ctx: ToolContext, toolName: string, toolLog: ToolLogEntry[]) {
  const input = {
    reason: "other",
    summary: `Automatic handoff: the assistant could not use ${toolName} after several tries in one message.`,
  };
  const started = Date.now();
  const result = await handoffToHuman.execute(input, ctx);
  toolLog.push({
    name: handoffToHuman.name,
    input,
    ok: result.ok,
    ...(!result.ok && "error" in result && { error: result.error }),
    durationMs: Date.now() - started,
  });
}

/**
 * Tool results of the whole conversation: the only allowed source of prices. The buyer's own budget is
 * allowed too, because update_lead returns it once saved ("save as you go" in the prompt).
 */
function toolResults(conversation: LlmMessage[]): string[] {
  return conversation.flatMap((m) => (m.role === "tool" ? [m.result] : []));
}

async function readLead(db: Db, leadId: string, now: Date): Promise<Lead> {
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  if (lead) return lead;
  const timestamp = now.toISOString();
  return { ...EMPTY_LEAD, id: leadId, createdAt: timestamp, updatedAt: timestamp };
}

const EMPTY_LEAD: Omit<Lead, "id" | "createdAt" | "updatedAt"> = {
  purpose: null,
  areas: null,
  beds: null,
  budgetAed: null,
  timeline: null,
  financing: null,
  status: "new",
  handoffReason: null,
  handoffSummary: null,
};

function promptContext(lead: Lead, now: Date): PromptContext {
  const { status, ...fields } = leadSummary(lead);
  return {
    now: { label: formatSlot(now).label },
    lead: { status, fields, missing: missingLeadFields(lead) },
  };
}

function addUsage(total: LlmUsage, add: LlmUsage) {
  total.inputTokens += add.inputTokens;
  total.outputTokens += add.outputTokens;
  total.cachedInputTokens += add.cachedInputTokens;
}
