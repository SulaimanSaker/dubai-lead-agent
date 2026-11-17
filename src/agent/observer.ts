/**
 * What the agent reports while it works, so a tracing backend (Langfuse, see src/agent/tracing/) can record it.
 * The agent only knows this interface. See docs/decisions/0005-tracing.md.
 *
 * Observers must never break a chat: `safeTrace` wraps every call, and errors are logged, not thrown.
 */
import type { LlmMessage, LlmResult, LlmUsage, ProviderName } from "@/agent/llm";

export interface TurnInfo {
  leadId: string;
  userMessage: string;
  provider: ProviderName;
  /** The model requested (a fallback can answer with another one; see ModelCallEnd). */
  model: string;
  promptVersion: string;
}

export interface TurnSummary {
  reply: string;
  outcome: string;
  steps: number;
  usage: LlmUsage;
  costUsd: number | null;
  latencyMs: number;
  /** The model that answered last. */
  model: string;
  guardEvents: { type: string; amounts: string[]; action: string }[];
  error?: string;
}

export interface ModelCallInfo {
  step: number;
  model: string;
  /** The conversation sent to the model (the system prompt is identified by the prompt version instead). */
  messages: LlmMessage[];
}

export type ModelCallEnd =
  | { result: LlmResult; costUsd: number | null; latencyMs: number }
  | { error: unknown; latencyMs: number };

export interface ToolCallInfo {
  callId: string;
  name: string;
  input: unknown;
}

export interface ToolCallEnd {
  ok: boolean;
  output: unknown;
  error?: string;
}

export interface GuardInfo {
  type: string;
  amounts: string[];
  action: string;
}

export interface TurnTrace {
  /** The tracing backend's id for this turn, if any (saved with the turn, so a trace can be found). */
  readonly traceId: string | null;
  modelCall(info: ModelCallInfo): { end(outcome: ModelCallEnd): void };
  toolCall(info: ToolCallInfo): { end(outcome: ToolCallEnd): void };
  guard(info: GuardInfo): void;
  finish(summary: TurnSummary): void;
}

export interface TurnObserver {
  /** Runs `work` as one traced turn. Must call `work` exactly once and return its result. */
  turn<T>(info: TurnInfo, work: (trace: TurnTrace) => Promise<T>): Promise<T>;
}

const noopSpan = { end() {} };

export const NOOP_TRACE: TurnTrace = {
  traceId: null,
  modelCall: () => noopSpan,
  toolCall: () => noopSpan,
  guard() {},
  finish() {},
};

export const NOOP_OBSERVER: TurnObserver = {
  turn: (_info, work) => work(NOOP_TRACE),
};

let warned = false;
function report(error: unknown) {
  if (warned) return;
  warned = true; // once per process: a broken tracer shouldn't flood the logs
  console.error("[tracing] observer failed; tracing errors are ignored from now on:", error);
}

function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (error) {
    report(error);
    return fallback;
  }
}

/** Wrap a trace so that no observer error can reach the agent. */
export function safeTrace(trace: TurnTrace): TurnTrace {
  const safeSpan = <E>(span: { end(outcome: E): void }) => ({
    end: (outcome: E) => attempt(() => span.end(outcome), undefined),
  });
  return {
    get traceId() {
      return attempt(() => trace.traceId, null);
    },
    modelCall: (info) => safeSpan(attempt(() => trace.modelCall(info), noopSpan)),
    toolCall: (info) => safeSpan(attempt(() => trace.toolCall(info), noopSpan)),
    guard: (info) => attempt(() => trace.guard(info), undefined),
    finish: (summary) => attempt(() => trace.finish(summary), undefined),
  };
}

/**
 * Run a turn through an observer without ever letting the observer break it:
 * - the observer fails before `work` starts → `work` runs untraced;
 * - the observer fails while or after `work` runs → we wait for that same run and return its result;
 * - `work` itself throws → that error passes through unchanged.
 * `work` runs at most once: a turn has side effects (bookings), so running it twice is never safe.
 */
export async function observeTurn<T>(
  observer: TurnObserver,
  info: TurnInfo,
  work: (trace: TurnTrace) => Promise<T>,
): Promise<T> {
  const run: { started?: Promise<T> } = {};
  try {
    return await observer.turn(info, (trace) => {
      run.started ??= work(safeTrace(trace));
      return run.started;
    });
  } catch (error) {
    if (!run.started) {
      report(error);
      return work(NOOP_TRACE);
    }
    // The turn already started: its own outcome wins. If it failed, that error is the real one.
    const value = await run.started;
    report(error);
    return value;
  }
}
