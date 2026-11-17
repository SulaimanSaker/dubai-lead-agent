import { z } from "zod";

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const envSchema = z.object({
  LANGFUSE_PUBLIC_KEY: optional(z.string().startsWith("pk-lf-", "should start with pk-lf-")),
  LANGFUSE_SECRET_KEY: optional(z.string().startsWith("sk-lf-", "should start with sk-lf-")),
  LANGFUSE_BASE_URL: optional(z.url()).transform((v) => v ?? "https://cloud.langfuse.com"),
  /** Set to "off" to disable tracing even when keys are present (e.g. in unit tests or CI). */
  LANGFUSE_TRACING: optional(z.enum(["on", "off"])).transform((v) => v ?? "on"),
});

export type TracingConfig =
  | { enabled: false; reason: string }
  | { enabled: true; publicKey: string; secretKey: string; baseUrl: string };

/** Tracing is on only when both Langfuse keys are set (and it isn't switched off). */
export function readTracingConfig(
  env: Record<string, string | undefined> = process.env,
): TracingConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid Langfuse settings in the environment:\n${z.prettifyError(parsed.error)}`,
    );
  }
  const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL, LANGFUSE_TRACING } =
    parsed.data;
  if (LANGFUSE_TRACING === "off") return { enabled: false, reason: "LANGFUSE_TRACING=off" };
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
    return { enabled: false, reason: "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set" };
  }
  return {
    enabled: true,
    publicKey: LANGFUSE_PUBLIC_KEY,
    secretKey: LANGFUSE_SECRET_KEY,
    baseUrl: LANGFUSE_BASE_URL,
  };
}
