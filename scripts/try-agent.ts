/**
 * Run scripted buyer conversations through the real agent (real model, fresh in-memory database),
 * and print what happened. A quick smoke test, not an eval: it prints, it doesn't score.
 *
 *   npm run agent:try                       (uses LLM_PROVIDER, default local)
 *   LLM_PROVIDER=claude npm run agent:try   (Claude, a fraction of a cent on Haiku)
 *   PowerShell: $env:LLM_PROVIDER="claude"; npm run agent:try
 *
 * "Now" is fixed to Mon 16 Nov 2026, 14:05 Dubai time, so runs are comparable.
 */
import { randomUUID } from "node:crypto";
import { handleBuyerMessage } from "@/agent/chat";
import { loadConversation } from "@/agent/conversation";
import { getLeadDetail } from "@/agent/leads";
import { getProvider } from "@/agent/llm";
import { createTestDb } from "@/db/test-db";

const NOW = new Date("2026-11-16T10:05:00Z");

const CONVERSATIONS: { name: string; messages: string[] }[] = [
  {
    name: "qualify and book",
    messages: [
      "Hi, I want to rent a 2 bed in Dubai Marina, budget around 120k a year, paying cash, moving next month.",
      "Tell me more about that one.",
      "Can I see it on Saturday?",
      "11am please.",
    ],
  },
  { name: "asks for a person", messages: ["I want to speak to a real person, not a bot."] },
];

async function main() {
  const db = await createTestDb();
  const provider = getProvider();
  console.log(`Provider: ${provider.name} · model: ${provider.model}\n`);
  let totalIn = 0;
  let totalOut = 0;

  for (const conversation of CONVERSATIONS) {
    console.log(`=== ${conversation.name} ===`);
    const leadId = randomUUID();
    for (const message of conversation.messages) {
      const started = Date.now();
      const response = await handleBuyerMessage(
        { leadId, message },
        { db, provider, now: () => NOW, newId: () => leadId },
      );
      const detail = await getLeadDetail(db, leadId);
      const last = detail?.transcript.at(-1);
      const turn = detail?.turns.at(-1)?.meta ?? {};
      totalIn += Number(turn.inputTokens ?? 0);
      totalOut += Number(turn.outputTokens ?? 0);
      console.log(`Buyer: ${message}`);
      console.log(`  tools: ${last?.toolsUsed.join(", ") || "none"}`);
      // Failed tool calls of this turn: what the model sent and what it was told.
      const saved = await loadConversation(db, leadId);
      const turnStart = saved.findLastIndex((m) => m.role === "user");
      const calls = new Map(
        saved.flatMap((m) => (m.role === "assistant" ? m.toolCalls.map((c) => [c.id, c]) : [])),
      );
      for (const m of saved.slice(turnStart)) {
        if (m.role !== "tool" || !m.isError) continue;
        const sent = JSON.stringify(calls.get(m.callId)?.input);
        const told = (JSON.parse(m.result) as { message?: string }).message?.replace(/\s+/g, " ");
        console.log(`  ✗ ${m.name}(${sent}) → ${told}`);
      }
      console.log(`Agent: ${response.reply}`);
      console.log(
        `  [${response.outcome} · ${Date.now() - started} ms · in ${String(turn.inputTokens)} ` +
          `(cached ${String(turn.cachedInputTokens)}) · out ${String(turn.outputTokens)}]\n`,
      );
    }
    const lead = await getLeadDetail(db, leadId);
    console.log(
      `Lead: status=${lead?.status} · score=${lead?.score.value} (${lead?.score.label}) · ` +
        `missing=${lead?.missing.join(", ") || "none"}`,
    );
    console.log(`Summary: ${lead?.summary}`);
    console.log(
      `Viewings: ${lead?.viewings.map((v) => `${v.listingId} ${v.label}`).join("; ") || "none"}\n`,
    );
  }
  console.log(`Total tokens: in ${totalIn} · out ${totalOut}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
