import type { PromptVersion } from "@/agent/prompts/types";
import { PROMPT_V1 } from "@/agent/prompts/v1";
import { PROMPT_V2 } from "@/agent/prompts/v2";
import { PROMPT_V3 } from "@/agent/prompts/v3";

export type { PromptContext, PromptVersion } from "@/agent/prompts/types";

/** Every released prompt, so evals can run an older version (`--prompt v1`). */
export const PROMPTS: Readonly<Record<string, PromptVersion>> = {
  v1: PROMPT_V1,
  v2: PROMPT_V2,
  v3: PROMPT_V3,
};

/** The version the app uses. Change it in one place after evals show the new one is better. */
// v3 won the 2026-11-21 evals: same price fix as v2, all replies in the buyer's language (docs/plans/2026-11-21-prompt-v2.md).
export const CURRENT_PROMPT: PromptVersion = PROMPT_V3;
