import { z } from "zod";
import type { Db } from "@/db/client";

/** Everything a tool may use. Passed in by the agent loop — tools never read globals or the system clock. */
export interface ToolContext {
  db: Db;
  /** The lead (buyer conversation) this call belongs to. */
  leadId: string;
  /** "Now", injected so tests and evals are repeatable. */
  now: Date;
}

/** A result the model should read and react to (bad input, nothing found, slot taken, ...). Not an exception. */
export interface ToolError {
  ok: false;
  error: "invalid_input" | "not_found" | "conflict" | "not_allowed";
  message: string;
}

/** The shape the agent loop and the model adapters work with. */
export interface AgentTool {
  /** snake_case name the model calls, e.g. "search_listings". */
  name: string;
  /** What the tool does and WHEN to use it. The model reads this — it is part of the prompt. */
  description: string;
  /** Validates the model's input. Also converted to JSON Schema for the model. */
  inputSchema: z.ZodObject;
  /** Validate raw model input, then run. Never throws for bad input — returns a ToolError instead. */
  execute(rawInput: unknown, ctx: ToolContext): Promise<{ ok: boolean }>;
}

/**
 * Models often send `null` or `""` for fields they don't know. Treat those as "not provided".
 * Without this, `z.coerce.number()` would turn `beds: null` into `0` — a studio — and silently corrupt data.
 */
function dropEmptyFields(rawInput: unknown): unknown {
  if (rawInput === null || rawInput === undefined) return {};
  if (typeof rawInput !== "object" || Array.isArray(rawInput)) return rawInput;
  return Object.fromEntries(
    Object.entries(rawInput).filter(([, value]) => value !== null && value !== ""),
  );
}

/**
 * Define a tool with a typed `run`. The returned `execute` validates the raw model input with the
 * Zod schema first, so `run` only ever sees valid, typed input.
 */
export function defineTool<S extends z.ZodObject, R extends { ok: boolean }>(def: {
  name: string;
  description: string;
  inputSchema: S;
  run(input: z.output<S>, ctx: ToolContext): Promise<R>;
}) {
  return {
    ...def,
    async execute(rawInput: unknown, ctx: ToolContext): Promise<R | ToolError> {
      const parsed = def.inputSchema.safeParse(dropEmptyFields(rawInput));
      if (!parsed.success) {
        return {
          ok: false,
          error: "invalid_input",
          message: `Invalid input for ${def.name}:\n${z.prettifyError(parsed.error)}`,
        };
      }
      return def.run(parsed.data, ctx);
    },
  } satisfies AgentTool & { run: typeof def.run };
}
