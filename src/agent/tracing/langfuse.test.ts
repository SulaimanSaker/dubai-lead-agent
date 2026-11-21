/**
 * The Langfuse mapping, end to end through the real LangfuseSpanProcessor, with an in-memory exporter instead of
 * the network. Checks what Langfuse would receive: span names, observation types, session, tags, usage, cost.
 */
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleBuyerMessage } from "@/agent/chat";
import { loadTurnMeta } from "@/agent/conversation";
import { CURRENT_PROMPT } from "@/agent/prompts";
import { FakeProvider, textStep, toolStep } from "@/agent/testing/fake-provider";
import { readTracingConfig } from "@/agent/tracing/config";
import { langfuseObserver } from "@/agent/tracing/langfuse";
import { flushTracing, startTracing, stopTracing } from "@/agent/tracing/setup";
import type { Db } from "@/db/client";
import { createTestDb } from "@/db/test-db";

const exporter = new InMemorySpanExporter();
const LEAD_ID = "5f0c6a7e-8a1b-4c2d-9e3f-0a1b2c3d4e5f";
let db: Db;

beforeAll(() => {
  expect(startTracing({ exporter, log: false })).toBe(true);
});
afterAll(async () => {
  await stopTracing();
});
beforeEach(async () => {
  db = await createTestDb();
  exporter.reset();
});

const attr = (span: ReadableSpan | undefined, key: string) => span?.attributes[key];
/** Langfuse stores objects as JSON text and plain strings as they are. */
const json = (span: ReadableSpan | undefined, key: string): unknown => {
  const value = attr(span, key);
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

async function runTurn(
  script: ConstructorParameters<typeof FakeProvider>[0],
  message = "2 bed in Marina",
) {
  const provider = new FakeProvider(script);
  const response = await handleBuyerMessage(
    { message },
    {
      db,
      provider,
      now: () => new Date("2026-11-16T10:05:00Z"),
      newId: () => LEAD_ID,
      observer: langfuseObserver,
    },
  );
  await flushTracing();
  const spans = exporter.getFinishedSpans();
  return { response, spans, byName: (name: string) => spans.filter((s) => s.name === name) };
}

describe("Langfuse trace of one buyer message", () => {
  it("has a root agent-turn in the lead's session, with the provider, model and prompt version as tags", async () => {
    const { spans, byName } = await runTurn([textStep("Hello!")], "Hi");
    const [root] = byName("agent-turn");
    expect(root).toBeDefined();
    expect(attr(root, "langfuse.observation.type")).toBe("agent");
    expect(attr(root, "session.id")).toBe(LEAD_ID);
    expect(attr(root, "langfuse.trace.name")).toBe("agent-turn");
    expect(attr(root, "langfuse.trace.tags")).toEqual([
      "local",
      "fake-model",
      `prompt-${CURRENT_PROMPT.version}`,
    ]);
    expect(json(root, "langfuse.observation.input")).toBe("Hi");
    expect(json(root, "langfuse.observation.output")).toBe("Hello!");
    // Every span belongs to the same trace, and all of them carry the session.
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    expect(spans.every((s) => attr(s, "session.id") === LEAD_ID)).toBe(true);
  });

  it("records a generation per model call with model, usage and cost, and a tool per tool call", async () => {
    const { byName } = await runTurn([
      toolStep(["update_lead", { beds: 2 }], ["get_listing", { listingId: "NOPE" }]),
      textStep("Noted!"),
    ]);
    const generations = [...byName("llm-call-1"), ...byName("llm-call-2")];
    expect(generations).toHaveLength(2);
    const [first] = generations;
    expect(attr(first, "langfuse.observation.type")).toBe("generation");
    expect(attr(first, "langfuse.observation.model.name")).toBe("fake-model");
    expect(json(first, "langfuse.observation.usage_details")).toEqual({
      input: 50,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 0,
      output: 10,
      total: 110,
    });
    expect(json(first, "langfuse.observation.cost_details")).toEqual({ total: 0 });

    const [updateLead] = byName("update_lead");
    expect(attr(updateLead, "langfuse.observation.type")).toBe("tool");
    expect(json(updateLead, "langfuse.observation.input")).toEqual({ beds: 2 });
    // A tool that returned ok: false is a warning, with the reason.
    const [getListing] = byName("get_listing");
    expect(attr(getListing, "langfuse.observation.level")).toBe("WARNING");
    expect(attr(getListing, "langfuse.observation.status_message")).toBe("not_found");
  });

  it("records the price guard as a guardrail and marks a failed turn", async () => {
    const { byName } = await runTurn([textStep("AED 99,000."), textStep("AED 98,000.")]);
    const guards = byName("price-guard");
    expect(guards.map((g) => attr(g, "langfuse.observation.type"))).toEqual([
      "guardrail",
      "guardrail",
    ]);
    const [root] = byName("agent-turn");
    expect(attr(root, "langfuse.observation.level")).toBe("WARNING");
    expect(attr(root, "langfuse.observation.status_message")).toMatch(/invented prices/);
  });

  it("does not export other libraries' GenAI spans (they would count every model call twice)", async () => {
    // What the Anthropic SDK does on every call: its own OpenTelemetry span with gen_ai.* attributes.
    const sdkSpan = trace.getTracer("@anthropic-ai/sdk").startSpan("anthropic.messages.create", {
      attributes: { "gen_ai.system": "anthropic", "gen_ai.usage.input_tokens": 100 },
    });
    sdkSpan.end();
    const { spans } = await runTurn([textStep("Hello!")]);
    expect(spans.map((s) => s.name)).not.toContain("anthropic.messages.create");
    expect(spans.map((s) => s.name).sort()).toEqual(["agent-turn", "llm-call-1"]);
  });

  it("saves the Langfuse trace id with the turn", async () => {
    const { spans } = await runTurn([textStep("Hello!")]);
    const [turn] = await loadTurnMeta(db, LEAD_ID);
    expect(turn?.meta?.traceId).toBe(spans[0]?.spanContext().traceId);
  });
});

describe("readTracingConfig", () => {
  it("is off without keys, or when switched off", () => {
    expect(readTracingConfig({})).toMatchObject({ enabled: false });
    expect(readTracingConfig({ LANGFUSE_PUBLIC_KEY: "", LANGFUSE_SECRET_KEY: "" })).toMatchObject({
      enabled: false,
    });
    expect(
      readTracingConfig({
        LANGFUSE_PUBLIC_KEY: "pk-lf-1",
        LANGFUSE_SECRET_KEY: "sk-lf-1",
        LANGFUSE_TRACING: "off",
      }),
    ).toMatchObject({ enabled: false, reason: "LANGFUSE_TRACING=off" });
  });

  it("is on with both keys, defaulting to the EU cloud", () => {
    expect(
      readTracingConfig({ LANGFUSE_PUBLIC_KEY: "pk-lf-1", LANGFUSE_SECRET_KEY: "sk-lf-1" }),
    ).toEqual({
      enabled: true,
      publicKey: "pk-lf-1",
      secretKey: "sk-lf-1",
      baseUrl: "https://cloud.langfuse.com",
    });
  });

  it("rejects keys swapped or mistyped", () => {
    expect(() =>
      readTracingConfig({ LANGFUSE_PUBLIC_KEY: "sk-lf-1", LANGFUSE_SECRET_KEY: "pk-lf-1" }),
    ).toThrow(/LANGFUSE_PUBLIC_KEY[\s\S]*LANGFUSE_SECRET_KEY/);
  });
});
