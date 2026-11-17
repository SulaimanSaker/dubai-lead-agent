import type { LlmUsage, ProviderName } from "@/agent/llm/types";

/**
 * USD per million tokens. Source: Anthropic's price list for the Claude API, checked 2026-11-17.
 * Update this table (and its date) when prices change. Costs shown anywhere in the app are estimates from it.
 */
export const PRICES_CHECKED_ON = "2026-11-17";

interface ModelPrice {
  input: number;
  output: number;
  /** Cache reads as a share of the input price. Not the same for every model. */
  cacheRead: number;
  /** Some models charge more per token for long prompts. */
  longPrompt?: { aboveInputTokens: number; input: number; output: number };
}

const CLAUDE_PRICES: Record<string, ModelPrice> = {
  // Cache reads $0.01 / M (0.1×). Above 100K input tokens: $0.50 / $2.50.
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.1,
    longPrompt: { aboveInputTokens: 100_000, input: 0.5, output: 2.5 },
  },
  // Cache reads $0.10 / M (0.05×).
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.05 },
  // Cache reads $0.20 / M (0.05×).
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.05 },
};

/** 5-minute cache writes cost 1.25× the input price on all of them. */
const CACHE_WRITE = 1.25;

/**
 * Cost of ONE model call in USD. Local models cost 0. An unknown model returns `null`, never a guess.
 * `usage.inputTokens` is the total input, including cached reads and cache writes.
 * After a server-side refusal fallback, `usage` covers the final attempt only (a declined attempt isn't counted).
 */
export function modelCallCostUsd(
  provider: ProviderName,
  model: string,
  usage: LlmUsage,
): number | null {
  if (provider === "local") return 0;
  const price = CLAUDE_PRICES[model];
  if (!price) return null;

  const long = price.longPrompt && usage.inputTokens > price.longPrompt.aboveInputTokens;
  const input = long && price.longPrompt ? price.longPrompt.input : price.input;
  const output = long && price.longPrompt ? price.longPrompt.output : price.output;

  const uncached = Math.max(
    0,
    usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens,
  );
  const dollars =
    (uncached * input +
      usage.cachedInputTokens * input * price.cacheRead +
      usage.cacheWriteInputTokens * input * CACHE_WRITE +
      usage.outputTokens * output) /
    1_000_000;
  return dollars; // full precision; round only for display
}

/** Sum of call costs; `null` if any call has an unknown price (a partial sum would look complete). */
export function addCosts(total: number | null, add: number | null): number | null {
  return total === null || add === null ? null : total + add;
}
