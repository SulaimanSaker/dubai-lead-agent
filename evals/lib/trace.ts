/**
 * The saved trace of one run (traces/<case>_rep<k>.json): the report links it, the judge grades it, a human
 * reads it. Saved traces can be re-graded later without running the agent again (`npm run evals:rejudge`).
 */
import type { LlmMessage } from "@/agent/llm";
import type { EvalCase } from "./cases";

export interface TraceTurn {
  /**
   * - `system`: the header (prompt version, case)
   * - `context`: the turn context the agent got (Dubai time, lead so far); the buyer doesn't see it
   * - `user`, `tool_call`, `tool_result`
   * - `assistant`: a reply the buyer saw
   * - `assistant_note`: text the model wrote next to a tool call; the chat never shows it to the buyer
   */
  role:
    "system" | "context" | "user" | "tool_call" | "tool_result" | "assistant" | "assistant_note";
  content: string;
  name?: string;
}

export function toTrace(
  evalCase: EvalCase,
  conversation: LlmMessage[],
  promptVersion: string,
): TraceTurn[] {
  const turns: TraceTurn[] = [
    {
      role: "system",
      content: `Prompt ${promptVersion} (src/agent/prompts/${promptVersion}.ts). Case: ${evalCase.description}`,
    },
  ];
  for (const message of conversation) {
    if (message.role === "user") turns.push({ role: "user", content: message.text });
    else if (message.role === "context") turns.push({ role: "context", content: message.text });
    else if (message.role === "tool")
      turns.push({ role: "tool_result", name: message.name, content: message.result });
    else {
      for (const call of message.toolCalls) {
        turns.push({
          role: "tool_call",
          name: call.name,
          content: JSON.stringify(call.input, null, 2),
        });
      }
      if (message.text) {
        const shown = message.toolCalls.length === 0;
        turns.push({ role: shown ? "assistant" : "assistant_note", content: message.text });
      }
    }
  }
  return turns;
}

/** The prompt version from the header line ("Prompt v1 (...)"). */
export function promptVersionOf(trace: TraceTurn[]): string {
  const version = trace[0]?.content.match(/^Prompt (v\d+)\b/)?.[1];
  if (!version) throw new Error(`Trace header has no prompt version: ${trace[0]?.content}`);
  return version;
}

/**
 * Traces saved before `context` and `assistant_note` existed used `system` for the turn context and
 * `assistant` for every text. `toTrace` writes a message's tool calls right before its text, so an `assistant`
 * line right after a `tool_call` came from a tool-call message: the buyer never saw it. Safe to run twice.
 */
export function upgradeTrace(trace: TraceTurn[]): TraceTurn[] {
  return trace.map((turn, index) => {
    if (index > 0 && turn.role === "system") return { ...turn, role: "context" };
    if (turn.role === "assistant" && trace[index - 1]?.role === "tool_call")
      return { ...turn, role: "assistant_note" };
    return turn;
  });
}
