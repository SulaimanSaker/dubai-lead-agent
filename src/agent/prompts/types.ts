/** What the dynamic part of a prompt may use. Built by the loop once per buyer message. */
export interface PromptContext {
  /** "Mon 16 Nov 2026, 14:05": Dubai wall-clock time, with the year. */
  now: { label: string };
  lead: {
    status: string;
    fields: Record<string, unknown>;
    missing: readonly string[];
  };
}

export interface PromptVersion {
  /** "v1", "v2", ... Recorded with every turn, so evals and traces can compare versions. */
  version: string;
  /** Same on every call, so providers can cache it. */
  stable: string;
  /**
   * The turn's context (time, lead state). Sent once per buyer message as a `context` message right after it,
   * never inside the system prompt (ADR 0006).
   */
  dynamic(context: PromptContext): string;
}
