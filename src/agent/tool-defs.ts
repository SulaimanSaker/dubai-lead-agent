import { z } from "zod";
import type { LlmToolDef } from "@/agent/llm";
import { TOOLS, type AgentTool } from "@/tools";

/** One tool as the model sees it: name, description and the JSON Schema of its input. */
export function toToolDef(tool: AgentTool): LlmToolDef {
  // `io: "input"` describes what the model may SEND (before Zod defaults/coercion), not what `run` gets.
  const schema: Record<string, unknown> = z.toJSONSchema(tool.inputSchema, { io: "input" });
  delete schema.$schema; // the "$schema" URL is noise for the model
  return {
    name: tool.name,
    description: tool.description,
    jsonSchema: { ...schema, type: "object" },
  };
}

/** Every tool, in a fixed order (a stable tool list keeps the prompt cache valid). */
export const TOOL_DEFS: readonly LlmToolDef[] = TOOLS.map(toToolDef);
