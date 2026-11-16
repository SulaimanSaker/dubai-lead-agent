import { describe, expect, it } from "vitest";
import { readLlmConfig } from "@/agent/llm/config";
import { getProvider } from "@/agent/llm";

describe("readLlmConfig", () => {
  it("defaults to the free local model", () => {
    expect(readLlmConfig({})).toEqual({
      LLM_PROVIDER: "local",
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_MODEL: "claude-haiku-5-5",
      CLAUDE_EFFORT: "low",
      LMSTUDIO_BASE_URL: "http://localhost:1234/v1",
      LMSTUDIO_MODEL: "google/gemma-3-4b",
    });
  });

  it("treats empty values (KEY= in .env) as not set", () => {
    const config = readLlmConfig({ LLM_PROVIDER: "", ANTHROPIC_API_KEY: "", CLAUDE_EFFORT: "" });
    expect(config.LLM_PROVIDER).toBe("local");
    expect(config.ANTHROPIC_API_KEY).toBeUndefined();
    expect(config.CLAUDE_EFFORT).toBe("low");
  });

  it("names every invalid variable in one error", () => {
    expect(() =>
      readLlmConfig({ LLM_PROVIDER: "gpt", CLAUDE_EFFORT: "extreme", LMSTUDIO_BASE_URL: "nope" }),
    ).toThrow(/LLM_PROVIDER[\s\S]*CLAUDE_EFFORT[\s\S]*LMSTUDIO_BASE_URL/);
  });
});

describe("getProvider", () => {
  it("picks the adapter from LLM_PROVIDER", () => {
    expect(getProvider(readLlmConfig({ LLM_PROVIDER: "claude" }))).toMatchObject({
      name: "claude",
      model: "claude-haiku-5-5",
    });
    expect(getProvider(readLlmConfig({}))).toMatchObject({
      name: "local",
      model: "google/gemma-3-4b",
    });
  });
});
