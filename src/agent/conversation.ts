import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { LlmMessage } from "@/agent/llm";
import type { Db } from "@/db/client";
import { messages } from "@/db/schema";

/** Facts about one assistant turn, for the agent view and (Phase 3) tracing. */
export interface TurnMeta {
  provider: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  latencyMs: number;
  outcome: string;
}

const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  inputError: z.string().nullable(),
});

/** Stored messages are read back through this schema: a bad row fails loudly instead of confusing the model. */
const storedMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), text: z.string() }),
  z.object({
    role: z.literal("assistant"),
    text: z.string(),
    toolCalls: z.array(toolCallSchema),
    providerData: z
      .object({ provider: z.enum(["claude", "local"]), model: z.string(), content: z.unknown() })
      .optional(),
  }),
  z.object({
    role: z.literal("tool"),
    callId: z.string(),
    name: z.string(),
    result: z.string(),
    isError: z.boolean(),
  }),
]);

/** The whole conversation for a lead, oldest first. */
export async function loadConversation(db: Db, leadId: string): Promise<LlmMessage[]> {
  const rows = await db
    .select({ id: messages.id, content: messages.content })
    .from(messages)
    .where(eq(messages.leadId, leadId))
    .orderBy(asc(messages.id));
  return rows.map((row) => {
    const parsed = storedMessageSchema.safeParse(row.content);
    if (!parsed.success) {
      throw new Error(
        `Stored message ${row.id} of lead ${leadId} is invalid: ${parsed.error.message}`,
      );
    }
    return parsed.data as LlmMessage;
  });
}

/**
 * Append the messages of one turn in a single batch (all or nothing).
 * `meta` is attached to the last assistant message of the turn.
 */
export async function appendMessages(
  db: Db,
  leadId: string,
  turn: LlmMessage[],
  now: Date,
  meta?: TurnMeta,
): Promise<void> {
  if (turn.length === 0) return;
  const lastAssistant = turn.findLastIndex((message) => message.role === "assistant");
  const createdAt = now.toISOString();
  const rows = turn.map((message, index) => ({
    leadId,
    role: message.role,
    content: message,
    meta: index === lastAssistant && meta ? { ...meta } : null,
    createdAt,
  }));
  const [first, ...rest] = rows.map((row) => db.insert(messages).values(row));
  if (!first) return;
  await db.batch([first, ...rest]);
}

/** Meta of every assistant turn for a lead (agent view: which model answered, tokens, latency). */
export async function loadTurnMeta(db: Db, leadId: string) {
  const rows = await db
    .select({ id: messages.id, meta: messages.meta, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.leadId, leadId))
    .orderBy(asc(messages.id));
  return rows.filter((row) => row.meta !== null);
}
