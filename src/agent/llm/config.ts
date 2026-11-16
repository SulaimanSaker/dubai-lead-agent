import { z } from "zod";

/** Empty values in .env files ("KEY=") mean "not set". */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const envSchema = z.object({
  LLM_PROVIDER: optional(z.enum(["claude", "local"])).transform((v) => v ?? "local"),
  // Not required here: the Anthropic SDK can also use an `ant auth login` profile.
  // If no credentials are found, the first call fails with an `auth` LlmError.
  ANTHROPIC_API_KEY: optional(z.string()),
  CLAUDE_MODEL: optional(z.string()).transform((v) => v ?? "claude-haiku-5-5"),
  CLAUDE_EFFORT: optional(z.enum(["low", "medium", "high", "xhigh", "max"])).transform(
    (v) => v ?? "low",
  ),
  LMSTUDIO_BASE_URL: optional(z.url()).transform((v) => v ?? "http://localhost:1234/v1"),
  LMSTUDIO_MODEL: optional(z.string()).transform((v) => v ?? "google/gemma-3-4b"),
});

export type LlmConfig = z.output<typeof envSchema>;

/** Read and validate the model settings. Throws one clear message listing every bad variable. */
export function readLlmConfig(env: Record<string, string | undefined> = process.env): LlmConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid model settings in the environment:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
