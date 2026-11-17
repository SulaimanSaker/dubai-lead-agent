/**
 * Record real model responses as test fixtures for the adapter contract test.
 *
 *   npm run llm:record -- local     (free, needs the LM Studio server)
 *   npm run llm:record -- claude    (costs a few cents, needs ANTHROPIC_API_KEY in .env.local)
 *
 * Saves the raw provider response for each scenario to src/agent/llm/fixtures/<provider>-<scenario>.json.
 * Unit tests only READ these files; they never call a model.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createClaudeProvider } from "@/agent/llm/claude";
import { readLlmConfig } from "@/agent/llm/config";
import { createLocalProvider } from "@/agent/llm/local";
import type { LlmMessage, LlmProvider, LlmRequest } from "@/agent/llm/types";
import { TOOL_DEFS } from "@/agent/tool-defs";

// Fixed for every scenario (a recording never changes the system prompt mid-conversation).
const SYSTEM =
  "You are a leasing assistant for a Dubai real estate agency. Use the tools to save what the " +
  "buyer tells you and to search listings. Never invent listings or prices. Keep replies short.\n\n" +
  "Current time in Dubai: Sun 15 Nov 2026, 10:00.";

const BUYER = "2 bed in Dubai Marina, budget around 120k a year, paying cash";

/** A tool call and its result, so the model has to answer from the result. */
const AFTER_TOOL: LlmMessage[] = [
  { role: "user", text: BUYER },
  {
    role: "assistant",
    text: "",
    toolCalls: [
      {
        id: "call_search_1",
        name: "search_listings",
        input: { purpose: "rent", area: "Dubai Marina", beds: 2, maxPriceAed: 120000 },
        inputError: null,
      },
    ],
  },
  {
    role: "tool",
    callId: "call_search_1",
    name: "search_listings",
    isError: false,
    result: JSON.stringify({
      ok: true,
      count: 1,
      listings: [
        {
          id: "L02",
          title: "2BR Marina Gate view",
          area: "Dubai Marina",
          beds: 2,
          priceAed: 115000,
        },
      ],
    }),
  },
];

const SCENARIOS: Record<string, LlmMessage[]> = {
  greeting: [{ role: "user", text: "Hi! Who am I talking to?" }],
  "text-reply": [{ role: "user", text: "Thanks, that's all for today. Bye!" }],
  "tool-call": [{ role: "user", text: BUYER }],
  "after-tool-result": AFTER_TOOL,
};

async function main() {
  const which = process.argv[2];
  if (which !== "local" && which !== "claude") {
    throw new Error("Usage: npm run llm:record -- local|claude");
  }
  const config = readLlmConfig();
  let raw: unknown;
  const onRawResponse = (response: unknown) => {
    raw = response;
  };
  const provider: LlmProvider =
    which === "claude"
      ? createClaudeProvider({
          model: config.CLAUDE_MODEL,
          effort: config.CLAUDE_EFFORT,
          apiKey: config.ANTHROPIC_API_KEY,
          onRawResponse,
        })
      : createLocalProvider({
          baseUrl: config.LMSTUDIO_BASE_URL,
          model: config.LMSTUDIO_MODEL,
          onRawResponse,
        });

  const dir = "src/agent/llm/fixtures";
  mkdirSync(dir, { recursive: true });
  for (const [scenario, messages] of Object.entries(SCENARIOS)) {
    const request: LlmRequest = { system: SYSTEM, messages, tools: [...TOOL_DEFS] };
    const started = Date.now();
    const result = await provider.generate(request);
    const file = `${dir}/${which}-${scenario}.json`;
    writeFileSync(
      file,
      JSON.stringify(
        { recorded: new Date().toISOString(), model: result.model, response: raw },
        null,
        2,
      ) + "\n",
    );
    const calls = result.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(", ");
    console.log(
      `${scenario}: stop=${result.stop} ${Date.now() - started}ms` +
        (calls ? ` tools=${calls}` : "") +
        (result.text ? ` text=${JSON.stringify(result.text.slice(0, 120))}` : ""),
    );
    console.log(`  → ${file}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
