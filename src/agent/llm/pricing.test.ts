import { describe, expect, it } from "vitest";
import { addCosts, modelCallCostUsd } from "@/agent/llm/pricing";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cachedInputTokens: cacheRead,
  cacheWriteInputTokens: cacheWrite,
});

describe("modelCallCostUsd", () => {
  it("prices a plain Haiku 5.5 call", () => {
    // 100K input at $0.10 / M + 100K output at $0.50 / M (100K is still the normal-price range)
    expect(modelCallCostUsd("claude", "claude-haiku-5-5", usage(100_000, 100_000))).toBe(0.06);
  });

  it("prices cache reads at 0.1x and cache writes at 1.25x of the input price", () => {
    // The real first recorded turn: 7,773 input of which 3,380 cached reads, 0 writes, 365 output.
    // uncached 4,393 × 0.10 + 3,380 × 0.01 + 365 × 0.50, per million
    expect(modelCallCostUsd("claude", "claude-haiku-5-5", usage(7_773, 365, 3_380))).toBeCloseTo(
      (4_393 * 0.1 + 3_380 * 0.01 + 365 * 0.5) / 1e6,
      8,
    );
    // A cache write of 2,711 tokens costs 1.25× normal input.
    expect(modelCallCostUsd("claude", "claude-haiku-5-5", usage(2_711, 0, 0, 2_711))).toBeCloseTo(
      (2_711 * 0.125) / 1e6,
      8,
    );
  });

  it("uses the long-prompt price above 100K input tokens", () => {
    expect(modelCallCostUsd("claude", "claude-haiku-5-5", usage(200_000, 0))).toBeCloseTo(0.1, 10);
  });

  it("prices cache reads per model: 0.05x on Sonnet 5.5 and Opus 5.5", () => {
    // 1M cached tokens: Sonnet $2 × 0.05 = $0.10, Opus $4 × 0.05 = $0.20 (Haiku would be 0.1x).
    expect(
      modelCallCostUsd("claude", "claude-sonnet-5-5", usage(1_000_000, 0, 1_000_000)),
    ).toBeCloseTo(0.1, 10);
    expect(
      modelCallCostUsd("claude", "claude-opus-5-5", usage(1_000_000, 0, 1_000_000)),
    ).toBeCloseTo(0.2, 10);
  });

  it("knows Sonnet 5.5 and Opus 5.5", () => {
    expect(modelCallCostUsd("claude", "claude-sonnet-5-5", usage(1_000_000, 0))).toBe(2);
    expect(modelCallCostUsd("claude", "claude-opus-5-5", usage(0, 1_000_000))).toBe(20);
  });

  it("is 0 for local models and null (not a guess) for unknown models", () => {
    expect(modelCallCostUsd("local", "google/gemma-3-4b", usage(5_000, 500))).toBe(0);
    expect(modelCallCostUsd("claude", "claude-future-9", usage(5_000, 500))).toBeNull();
  });
});

describe("addCosts", () => {
  it("adds, and stays null once any part is unknown", () => {
    expect(addCosts(0.001, 0.002)).toBeCloseTo(0.003, 12);
    expect(addCosts(0.001, null)).toBeNull();
    expect(addCosts(null, 0.002)).toBeNull();
  });
});
