import { createClaudeProvider } from "@/agent/llm/claude";
import { readLlmConfig, type LlmConfig } from "@/agent/llm/config";
import { createLocalProvider } from "@/agent/llm/local";
import type { LlmProvider } from "@/agent/llm/types";

export * from "@/agent/llm/types";

/** The model provider chosen by `LLM_PROVIDER` (claude | local). */
export function getProvider(config: LlmConfig = readLlmConfig()): LlmProvider {
  if (config.LLM_PROVIDER === "claude") {
    return createClaudeProvider({
      model: config.CLAUDE_MODEL,
      effort: config.CLAUDE_EFFORT,
      apiKey: config.ANTHROPIC_API_KEY,
    });
  }
  return createLocalProvider({ baseUrl: config.LMSTUDIO_BASE_URL, model: config.LMSTUDIO_MODEL });
}
