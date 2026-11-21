import { eq } from "drizzle-orm";
import { findInventedPrices, safeReply, type SafeReplyKind } from "@/agent/guards";
import {
  LlmError,
  toAssistantMessage,
  type LlmMessage,
  type LlmProvider,
  type LlmResult,
  type LlmToolCall,
  type LlmUsage,
} from "@/agent/llm";
import { addCosts, modelCallCostUsd } from "@/agent/llm/pricing";
import { NOOP_TRACE, type TurnTrace } from "@/agent/observer";
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
  /** Where to report model calls, tool calls and guard events (tracing). Default: nowhere. */
  trace?: TurnTrace;
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
  | "cut_off"
  /** A bug or database error in our own code. Logged; the messages so far are kept. */
  | "internal_error";

export interface AgentTurnResult {
  reply: string;
  /** Messages to save, in order: the user message, then every assistant and tool message of this turn. */
  newMessages: LlmMessage[];
  outcome: TurnOutcome;
  toolLog: ToolLogEntry[];
  guardEvents: GuardEvent[];
  /** Summed over every model call of the turn. */
  usage: LlmUsage;
  /** Estimated USD cost of all model calls (src/agent/llm/pricing.ts); null if a model has no known price. */
  costUsd: number | null;
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
 * repeat until it replies. Never throws: model and tool problems end in a safe reply, and a bug or
 * database error in our own code is logged and ends as `internal_error`, keeping the messages so far
 * (so tool side effects, like a booking, are never saved without the messages that explain them).
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
  const usage: LlmUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
  const failures = new Map<string, number>();
  const trace = input.trace ?? NOOP_TRACE;
  let costUsd: number | null = 0;
  let model = input.provider.model;
  let steps = 0;
  let retriedPrices = false;

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
      costUsd,
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
    // The turn's context (Dubai time, lead so far) is added ONCE, after the buyer's message, and saved.
    // The system prompt never changes, and nothing sent before is ever edited (ADR 0006).
    const lead = await readLead(input.db, input.leadId, input.now);
    const context: LlmMessage = {
      role: "context",
      text: prompt.dynamic(promptContext(lead, input.now)),
    };
    conversation.push(context);
    newMessages.push(context);

    while (steps < limits.maxSteps) {
      steps++;
      let result: LlmResult;
      const span = trace.modelCall({
        step: steps,
        model: input.provider.model,
        messages: [...conversation],
      });
      const callStarted = Date.now();
      try {
        result = await input.provider.generate({
          system: prompt.stable,
          messages: conversation,
          tools: [...TOOL_DEFS],
          signal: abort.signal,
        });
      } catch (error) {
        span.end({ error, latencyMs: Date.now() - callStarted });
        if (!(error instanceof LlmError)) throw error;
        console.error(`[agent] lead ${input.leadId}: ${error.kind}: ${error.message}`);
        return fallback(
          "error",
          error.kind === "timeout" ? "timeout" : "provider_error",
          error.message,
        );
      }
      const callCost = modelCallCostUsd(input.provider.name, result.model, result.usage);
      span.end({ result, costUsd: callCost, latencyMs: Date.now() - callStarted });
      addUsage(usage, result.usage);
      costUsd = addCosts(costUsd, callCost);
      model = result.model;

      // A tool stop with no usable calls is treated as a text answer (or an empty one below).
      // Saving it as a tool turn would leave an assistant turn with nothing after it.
      if (result.stop === "tool_use" && result.toolCalls.length > 0) {
        const assistant = toAssistantMessage(result);
        conversation.push(assistant);
        newMessages.push(assistant);
        for (const call of result.toolCalls) {
          const toolMessage = await runTool(call, ctx, toolLog, trace);
          conversation.push(toolMessage);
          newMessages.push(toolMessage);
          if (toolMessage.isError && isMisuse(toolMessage.result)) {
            failures.set(call.name, (failures.get(call.name) ?? 0) + 1);
          }
        }
        const failing = [...failures].find(([, count]) => count >= limits.maxToolFailures);
        if (failing) {
          await handoffAfterFailures(ctx, failing[0], toolLog, trace);
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
        const action = retriedPrices ? "replaced" : "retried";
        const event: GuardEvent = { type: "invented_price", amounts, action };
        guardEvents.push(event);
        trace.guard(event);
        if (action === "retried") {
          // Drop the draft (it was never sent back, so dropping it edits nothing) and ask once more,
          // with the correction added as a context message (saved, like any message).
          retriedPrices = true;
          const note: LlmMessage = { role: "context", text: prompt.priceCorrection(invented) };
          conversation.push(note);
          newMessages.push(note);
          continue;
        }
        return fallback("price_check", "price_guard", `invented prices: ${amounts.join(", ")}`);
      }

      return finish(result.text, "replied", { assistant: toAssistantMessage(result) });
    }

    return fallback("error", "max_steps", `no reply after ${limits.maxSteps} model calls`);
  } catch (error) {
    // Not a model problem (those are handled above): a bug or a database error. Make it loud in the logs,
    // but still end the turn cleanly. newMessages ends with a user or tool message here (runTool never
    // throws), so the fixed reply keeps the conversation valid.
    console.error(`[agent] internal error for lead ${input.leadId}:`, error);
    return fallback(
      "error",
      "internal_error",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Run one tool call. Every problem becomes an error result the model can read; nothing throws. */
async function runTool(
  call: LlmToolCall,
  ctx: ToolContext,
  toolLog: ToolLogEntry[],
  trace: TurnTrace,
): Promise<Extract<LlmMessage, { role: "tool" }>> {
  const started = Date.now();
  const span = trace.toolCall({ callId: call.id, name: call.name, input: call.input });
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
  span.end({ ok: result.ok, output: result, ...(!result.ok && { error: result.error }) });
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
async function handoffAfterFailures(
  ctx: ToolContext,
  toolName: string,
  toolLog: ToolLogEntry[],
  trace: TurnTrace,
) {
  const input = {
    reason: "other",
    summary: `Automatic handoff: the assistant could not use ${toolName} after several tries in one message.`,
  };
  const started = Date.now();
  const span = trace.toolCall({ callId: "automatic-handoff", name: handoffToHuman.name, input });
  const result = await handoffToHuman.execute(input, ctx);
  const error = !result.ok && "error" in result ? result.error : undefined;
  toolLog.push({
    name: handoffToHuman.name,
    input,
    ok: result.ok,
    ...(error && { error }),
    durationMs: Date.now() - started,
  });
  span.end({ ok: result.ok, output: result, ...(error && { error }) });
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
  total.cacheWriteInputTokens += add.cacheWriteInputTokens;
}
