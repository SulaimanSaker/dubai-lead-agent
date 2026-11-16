import type { PromptVersion } from "@/agent/prompts/types";
import { PROMPT_V1 } from "@/agent/prompts/v1";

export type { PromptContext, PromptVersion } from "@/agent/prompts/types";

/** Every released prompt, so evals can run an older version (`--prompt v1`). */
export const PROMPTS: Readonly<Record<string, PromptVersion>> = { v1: PROMPT_V1 };

/** The version the app uses. Change it in one place after evals show the new one is better. */
export const CURRENT_PROMPT: PromptVersion = PROMPT_V1;
