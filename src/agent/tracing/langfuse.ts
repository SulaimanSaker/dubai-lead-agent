import { propagateAttributes, startActiveObservation, type LangfuseAgent } from "@langfuse/tracing";
import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import type { LlmMessage, LlmUsage } from "@/agent/llm";
import {
  NOOP_TRACE,
  type ModelCallEnd,
  type TurnInfo,
  type TurnObserver,
  type TurnSummary,
  type TurnTrace,
} from "@/agent/observer";
import { isTracingOn } from "@/agent/tracing/setup";

/** Messages as Langfuse shows them: readable chat format, without provider-internal data. */
function toLangfuseMessages(messages: LlmMessage[]) {
  return messages.map((message) => {
    if (message.role === "user") return { role: "user", content: message.text };
    if (message.role === "context") return { role: "system", content: message.text };
    if (message.role === "tool") {
      return {
        role: "tool",
        name: message.name,
        tool_call_id: message.callId,
        content: message.result,
      };
    }
    return {
      role: "assistant",
      content: message.text,
      ...(message.toolCalls.length > 0 && {
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.input,
        })),
      }),
    };
  });
}

/** Token counts with the cache split out, so Langfuse shows what was cached. */
function usageDetails(usage: LlmUsage): Record<string, number> {
  return {
    input: Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens),
    cache_read_input_tokens: usage.cachedInputTokens,
    cache_creation_input_tokens: usage.cacheWriteInputTokens,
    output: usage.outputTokens,
    total: usage.inputTokens + usage.outputTokens,
  };
}

const FAILED = new Set(["internal_error", "provider_error", "timeout"]);

class LangfuseTurnTrace implements TurnTrace {
  constructor(private readonly root: LangfuseAgent) {}

  get traceId() {
    return this.root.traceId;
  }

  modelCall(info: { step: number; model: string; messages: LlmMessage[] }) {
    const generation = this.root.startObservation(
      `llm-call-${info.step}`,
      {
        model: info.model,
        input: toLangfuseMessages(info.messages),
        metadata: { step: info.step },
      },
      { asType: "generation" },
    );
    return {
      end: (outcome: ModelCallEnd) => {
        if ("error" in outcome) {
          generation.update({
            level: "ERROR",
            statusMessage:
              outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
            metadata: { latencyMs: outcome.latencyMs },
          });
        } else {
          const { result } = outcome;
          generation.update({
            model: result.model,
            output: {
              text: result.text,
              ...(result.toolCalls.length > 0 && {
                tool_calls: result.toolCalls.map((call) => ({
                  name: call.name,
                  arguments: call.input,
                })),
              }),
            },
            usageDetails: usageDetails(result.usage),
            ...(outcome.costUsd !== null && { costDetails: { total: outcome.costUsd } }),
            metadata: { stop: result.stop, latencyMs: outcome.latencyMs },
            ...(result.stop === "refusal" || result.stop === "max_tokens"
              ? { level: "WARNING" as const, statusMessage: `stop: ${result.stop}` }
              : {}),
          });
        }
        generation.end();
      },
    };
  }

  toolCall(info: { callId: string; name: string; input: unknown }) {
    const tool = this.root.startObservation(
      info.name,
      { input: info.input, metadata: { callId: info.callId } },
      { asType: "tool" },
    );
    return {
      end: (outcome: { ok: boolean; output: unknown; error?: string }) => {
        tool.update({
          output: outcome.output,
          // Not every failure is a bug ("slot taken" is normal), so a failed tool is a warning, not an error.
          ...(!outcome.ok && {
            level: "WARNING" as const,
            statusMessage: outcome.error ?? "failed",
          }),
        });
        tool.end();
      },
    };
  }

  guard(info: { type: string; amounts: string[]; action: string }) {
    this.root
      .startObservation(
        "price-guard",
        {
          input: { amounts: info.amounts },
          output: { action: info.action },
          level: "WARNING",
          statusMessage: `${info.type}: ${info.action}`,
        },
        { asType: "guardrail" },
      )
      .end();
  }

  finish(summary: TurnSummary) {
    this.root.update({
      output: summary.reply,
      metadata: {
        outcome: summary.outcome,
        steps: summary.steps,
        costUsd: summary.costUsd,
        latencyMs: summary.latencyMs,
        answeredBy: summary.model,
        usage: summary.usage,
        ...(summary.guardEvents.length > 0 && { guardEvents: summary.guardEvents }),
      },
      ...(summary.outcome !== "replied" && {
        level: FAILED.has(summary.outcome) ? ("ERROR" as const) : ("WARNING" as const),
        statusMessage: summary.error ?? summary.outcome,
      }),
    });
  }
}

/**
 * Traces each buyer message as a Langfuse trace "agent-turn", in a session per lead.
 * When tracing isn't set up, turns run untraced.
 */
export const langfuseObserver: TurnObserver = {
  turn<T>(info: TurnInfo, work: (trace: TurnTrace) => Promise<T>): Promise<T> {
    if (!isTracingOn()) return work(NOOP_TRACE);
    // ROOT_CONTEXT: each turn is its own trace, even inside a Next.js request (whose own spans aren't sent
    // to Langfuse, so a parent there would leave the turn hanging under a missing span).
    // Everything created inside gets the session, tags and prompt version (Langfuse propagated attributes).
    return context.with(ROOT_CONTEXT, () =>
      propagateAttributes(
        {
          traceName: "agent-turn",
          sessionId: info.leadId,
          version: info.promptVersion,
          tags: [info.provider, info.model, `prompt-${info.promptVersion}`],
        },
        () =>
          startActiveObservation(
            "agent-turn",
            async (root) => {
              root.update({
                input: info.userMessage,
                metadata: {
                  provider: info.provider,
                  model: info.model,
                  promptVersion: info.promptVersion,
                },
              });
              return work(new LangfuseTurnTrace(root));
            },
            { asType: "agent" },
          ),
      ),
    );
  },
};
